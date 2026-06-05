// BotflowCameraShim — webcam-into-Simulator camera bridge.
//
// The iOS Simulator has no camera: AVCaptureDevice.default(for:.video) is nil
// and the real capture graph produces no frames. This dylib is injected into the
// app at launch (SIMCTL_CHILD_DYLD_INSERT_LIBRARIES) and swizzles AVFoundation so
// that a *parallel fake capture graph* runs instead:
//
//   • Device discovery returns a synthetic "Botflow Webcam" device (so the app's
//     `guard let device = …` succeeds).
//   • AVCaptureDeviceInput creation for that device returns a dummy input.
//   • AVCaptureSession.addInput/addOutput accept our dummy + remember real
//     AVCaptureVideoDataOutput / AVCapturePhotoOutput objects.
//   • startRunning starts a frame pump fed by JPEG frames pulled over a WebSocket
//     from the host agent (which relays the browser webcam). Each frame is
//     decoded → CVPixelBuffer → CMSampleBuffer and delivered to the app's
//     sample-buffer delegate, and drawn into any AVCaptureVideoPreviewLayer.
//   • capturePhoto returns the current frame as the captured photo.
//
// The real AVFoundation machinery is never engaged — we bypass it entirely, so
// the simulator's lack of a camera doesn't matter.
//
// Connection string comes from the BOTFLOW_CAMERA_URL env var
// (ws://127.0.0.1:<port>/camera?session=…&token=…), set by the host agent.
//
// NOTE: swizzling AVFoundation is inherently best-effort — exotic capture setups
// (UIImagePickerController, multi-cam, raw photo, metadata outputs) are out of
// scope for v1 and may need additional hooks.

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <objc/message.h>

// Forward declarations for the C image helpers (defined lower down).
static CGImageRef BFCreateCGImageFromJPEG(NSData *data);
static CMSampleBufferRef BFCreateSampleBuffer(CGImageRef image, int64_t frameIndex);

// ──────────────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────────────
static void BFLog(NSString *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:args];
  va_end(args);
  NSLog(@"[BotflowCameraShim] %@", msg);
}

// ──────────────────────────────────────────────────────────────────────────────
// Swizzle helpers
// ──────────────────────────────────────────────────────────────────────────────
static void BFSwizzleInstance(Class cls, SEL orig, SEL repl) {
  if (!cls) return;
  Method m1 = class_getInstanceMethod(cls, orig);
  Method m2 = class_getInstanceMethod(cls, repl);
  if (!m2) return;
  if (m1) {
    // Add the original selector pointing at the replacement IMP first, in case
    // `orig` is inherited rather than defined on cls; then exchange.
    if (class_addMethod(cls, orig, method_getImplementation(m2), method_getTypeEncoding(m2))) {
      class_replaceMethod(cls, repl, method_getImplementation(m1), method_getTypeEncoding(m1));
    } else {
      method_exchangeImplementations(m1, m2);
    }
  } else {
    // No original — just add our impl under the orig selector.
    class_addMethod(cls, orig, method_getImplementation(m2), method_getTypeEncoding(m2));
  }
}

static void BFSwizzleClass(Class cls, SEL orig, SEL repl) {
  BFSwizzleInstance(object_getClass(cls), orig, repl); // metaclass
}

// ──────────────────────────────────────────────────────────────────────────────
// Synthetic device — minimal AVCaptureDevice stand-in
// ──────────────────────────────────────────────────────────────────────────────
// We can't construct a real AVCaptureDevice, so the app gets this object. It
// must survive the calls a typical app makes between discovery and startRunning
// (position, deviceType, lockForConfiguration:, focus/exposure setters). Unknown
// selectors are absorbed via forwardInvocation to avoid crashes.
@interface BotflowFakeDevice : NSObject
@property (nonatomic) AVCaptureDevicePosition position;
@end

@implementation BotflowFakeDevice
- (instancetype)init {
  if ((self = [super init])) { _position = AVCaptureDevicePositionBack; }
  return self;
}
- (NSString *)uniqueID { return @"botflow-webcam"; }
- (NSString *)modelID { return @"BotflowWebcam"; }
- (NSString *)localizedName { return @"Botflow Webcam"; }
- (BOOL)hasMediaType:(AVMediaType)mediaType { return [mediaType isEqualToString:AVMediaTypeVideo]; }
- (BOOL)supportsAVCaptureSessionPreset:(AVCaptureSessionPreset)preset { return YES; }
- (BOOL)lockForConfiguration:(NSError **)error { if (error) *error = nil; return YES; }
- (void)unlockForConfiguration {}
- (BOOL)isConnected { return YES; }
- (NSArray *)formats { return @[]; }
// Absorb any other AVCaptureDevice message the app sends (focus/exposure/zoom
// getters & setters) without crashing. Getters return 0/nil/NO.
- (NSMethodSignature *)methodSignatureForSelector:(SEL)sel {
  NSMethodSignature *sig = [super methodSignatureForSelector:sel];
  if (sig) return sig;
  return [NSMethodSignature signatureWithObjCTypes:"@@:"]; // id (id, SEL)
}
- (void)forwardInvocation:(NSInvocation *)inv {
  // Default: do nothing, return zero/nil for the return slot.
  NSUInteger len = inv.methodSignature.methodReturnLength;
  if (len > 0) {
    void *zero = calloc(1, len);
    [inv setReturnValue:zero];
    free(zero);
  }
}
- (BOOL)respondsToSelector:(SEL)aSelector { return YES; }
@end

// ──────────────────────────────────────────────────────────────────────────────
// Frame registry — drives the fake graph
// ──────────────────────────────────────────────────────────────────────────────
@interface BotflowFrameSource : NSObject <NSURLSessionWebSocketDelegate>
+ (instancetype)shared;
- (void)connectIfNeeded;
// Outputs/sessions/preview layers register themselves so frames reach them.
- (void)registerVideoOutput:(AVCaptureVideoDataOutput *)output;
- (void)registerPreviewLayer:(AVCaptureVideoPreviewLayer *)layer;
- (void)sessionDidStartRunning;
- (void)sessionDidStopRunning;
// Latest decoded frame (for capturePhoto).
@property (nonatomic, readonly) CGImageRef latestCGImage;
@end

@implementation BotflowFrameSource {
  NSURLSession *_session;
  NSURLSessionWebSocketTask *_task;
  NSString *_urlString;
  BOOL _connecting;
  NSInteger _runningSessions;
  NSHashTable<AVCaptureVideoDataOutput *> *_videoOutputs;
  NSHashTable<AVCaptureVideoPreviewLayer *> *_previewLayers;
  CGImageRef _latestCGImage;
  int64_t _frameIndex;
}

+ (instancetype)shared {
  static BotflowFrameSource *s;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ s = [BotflowFrameSource new]; });
  return s;
}

- (instancetype)init {
  if ((self = [super init])) {
    _videoOutputs = [NSHashTable weakObjectsHashTable];
    _previewLayers = [NSHashTable weakObjectsHashTable];
    _urlString = [[NSProcessInfo processInfo].environment objectForKey:@"BOTFLOW_CAMERA_URL"];
  }
  return self;
}

- (CGImageRef)latestCGImage { return _latestCGImage; }

- (void)registerVideoOutput:(AVCaptureVideoDataOutput *)output {
  @synchronized (self) { [_videoOutputs addObject:output]; }
}
- (void)registerPreviewLayer:(AVCaptureVideoPreviewLayer *)layer {
  @synchronized (self) { [_previewLayers addObject:layer]; }
}

- (void)sessionDidStartRunning {
  @synchronized (self) { _runningSessions++; }
  [self connectIfNeeded];
}
- (void)sessionDidStopRunning {
  @synchronized (self) { if (_runningSessions > 0) _runningSessions--; }
}

- (void)connectIfNeeded {
  if (!_urlString.length) {
    BFLog(@"No BOTFLOW_CAMERA_URL set — camera frames unavailable.");
    return;
  }
  @synchronized (self) {
    if (_task || _connecting) return;
    _connecting = YES;
  }
  NSURL *url = [NSURL URLWithString:_urlString];
  if (!url) { _connecting = NO; return; }
  _session = [NSURLSession sessionWithConfiguration:[NSURLSessionConfiguration defaultSessionConfiguration]
                                           delegate:self
                                      delegateQueue:nil];
  _task = [_session webSocketTaskWithURL:url];
  [_task resume];
  [self receiveLoop];
  BFLog(@"Connecting to %@", _urlString);
}

- (void)receiveLoop {
  __weak typeof(self) weakSelf = self;
  [_task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    typeof(self) self = weakSelf;
    if (!self) return;
    if (error) {
      BFLog(@"WS receive error: %@ — reconnecting", error.localizedDescription);
      [self scheduleReconnect];
      return;
    }
    if (message.type == NSURLSessionWebSocketMessageTypeData && message.data.length > 0) {
      [self handleJPEG:message.data];
    }
    [self receiveLoop];
  }];
}

- (void)scheduleReconnect {
  @synchronized (self) {
    _task = nil;
    _connecting = NO;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)),
                 dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @synchronized (self) { if (self->_runningSessions <= 0) return; }
    [self connectIfNeeded];
  });
}

// ── Frame delivery ──────────────────────────────────────────────────────────
- (void)handleJPEG:(NSData *)jpeg {
  CGImageRef image = BFCreateCGImageFromJPEG(jpeg);
  if (!image) return;
  @synchronized (self) {
    if (_latestCGImage) CGImageRelease(_latestCGImage);
    _latestCGImage = CGImageRetain(image);
  }
  [self deliverToPreviewLayers:image];
  [self deliverToVideoOutputs:image];
  CGImageRelease(image);
}

- (void)deliverToPreviewLayers:(CGImageRef)image {
  NSArray *layers;
  @synchronized (self) { layers = _previewLayers.allObjects; }
  if (layers.count == 0) return;
  CGImageRef retained = CGImageRetain(image);
  dispatch_async(dispatch_get_main_queue(), ^{
    for (AVCaptureVideoPreviewLayer *layer in layers) {
      CALayer *content = [layer valueForKey:@"botflowContentLayer"] ?: nil;
      if (![content isKindOfClass:[CALayer class]]) {
        content = [CALayer layer];
        content.frame = layer.bounds;
        content.contentsGravity = kCAGravityResizeAspectFill;
        [layer addSublayer:content];
        [layer setValue:content forKey:@"botflowContentLayer"];
      }
      content.frame = layer.bounds;
      [CATransaction begin];
      [CATransaction setDisableActions:YES];
      content.contents = (__bridge id)retained;
      [CATransaction commit];
    }
    CGImageRelease(retained);
  });
}

- (void)deliverToVideoOutputs:(CGImageRef)image {
  NSArray<AVCaptureVideoDataOutput *> *outputs;
  @synchronized (self) { outputs = _videoOutputs.allObjects; }
  if (outputs.count == 0) return;

  CMSampleBufferRef sample = BFCreateSampleBuffer(image, _frameIndex++);
  if (!sample) return;

  for (AVCaptureVideoDataOutput *output in outputs) {
    id<AVCaptureVideoDataOutputSampleBufferDelegate> delegate = output.sampleBufferDelegate;
    dispatch_queue_t queue = output.sampleBufferCallbackQueue;
    if (!delegate || !queue) continue;
    if (![delegate respondsToSelector:@selector(captureOutput:didOutputSampleBuffer:fromConnection:)]) continue;
    CMSampleBufferRef retained = (CMSampleBufferRef)CFRetain(sample);
    dispatch_async(queue, ^{
      // Connection is nil — the fake graph has no real ports. Most consumers use
      // only the sample buffer; those that need a connection are unsupported in v1.
      AVCaptureConnection *connection = nil;
      [delegate captureOutput:output didOutputSampleBuffer:retained fromConnection:connection];
      CFRelease(retained);
    });
  }
  CFRelease(sample);
}

- (CMSampleBufferRef)copyLatestSampleBuffer {
  CGImageRef image;
  @synchronized (self) { image = _latestCGImage ? CGImageRetain(_latestCGImage) : NULL; }
  if (!image) return NULL;
  CMSampleBufferRef sample = BFCreateSampleBuffer(image, _frameIndex++);
  CGImageRelease(image);
  return sample;
}

// ── NSURLSessionWebSocketDelegate ─────────────────────────────────────────────
- (void)URLSession:(NSURLSession *)session
      webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask
 didOpenWithProtocol:(NSString *)protocol {
  BFLog(@"WS open");
}
- (void)URLSession:(NSURLSession *)session
      webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask
   didCloseWithCode:(NSURLSessionWebSocketCloseCode)closeCode
             reason:(NSData *)reason {
  BFLog(@"WS closed (%ld)", (long)closeCode);
  [self scheduleReconnect];
}
@end

// ──────────────────────────────────────────────────────────────────────────────
// Image helpers
// ──────────────────────────────────────────────────────────────────────────────
static CGImageRef BFCreateCGImageFromJPEG(NSData *data) {
  CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
  if (!src) return NULL;
  CGImageRef image = CGImageSourceCreateImageAtIndex(src, 0, NULL);
  CFRelease(src);
  return image; // caller owns
}

// Draw a CGImage into a fresh BGRA CVPixelBuffer and wrap it in a CMSampleBuffer
// with a real running timestamp so AVFoundation consumers accept it.
static CMSampleBufferRef BFCreateSampleBuffer(CGImageRef image, int64_t frameIndex) {
  size_t width = CGImageGetWidth(image);
  size_t height = CGImageGetHeight(image);
  if (width == 0 || height == 0) return NULL;

  NSDictionary *attrs = @{
    (id)kCVPixelBufferCGImageCompatibilityKey: @YES,
    (id)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES,
    (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
  };
  CVPixelBufferRef pixelBuffer = NULL;
  CVReturn rc = CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                                    kCVPixelFormatType_32BGRA,
                                    (__bridge CFDictionaryRef)attrs, &pixelBuffer);
  if (rc != kCVReturnSuccess || !pixelBuffer) return NULL;

  CVPixelBufferLockBaseAddress(pixelBuffer, 0);
  void *base = CVPixelBufferGetBaseAddress(pixelBuffer);
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(base, width, height, 8,
                                           CVPixelBufferGetBytesPerRow(pixelBuffer), cs,
                                           kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
  if (ctx) {
    CGContextDrawImage(ctx, CGRectMake(0, 0, width, height), image);
    CGContextRelease(ctx);
  }
  CGColorSpaceRelease(cs);
  CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);

  CMVideoFormatDescriptionRef format = NULL;
  if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixelBuffer, &format) != noErr) {
    CVPixelBufferRelease(pixelBuffer);
    return NULL;
  }

  // 30fps nominal timeline driven by a monotonic frame counter.
  CMTime ts = CMTimeMake(frameIndex, 30);
  CMSampleTimingInfo timing = { .duration = CMTimeMake(1, 30), .presentationTimeStamp = ts, .decodeTimeStamp = kCMTimeInvalid };

  CMSampleBufferRef sample = NULL;
  OSStatus s = CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault, pixelBuffer, true, NULL, NULL,
                                                  format, &timing, &sample);
  CFRelease(format);
  CVPixelBufferRelease(pixelBuffer);
  if (s != noErr) { if (sample) CFRelease(sample); return NULL; }
  return sample; // caller owns
}

// ──────────────────────────────────────────────────────────────────────────────
// Swizzled AVFoundation
// ──────────────────────────────────────────────────────────────────────────────
static id BFFakeDevice(void) {
  static BotflowFakeDevice *d;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ d = [BotflowFakeDevice new]; });
  return d;
}

@implementation AVCaptureDevice (BotflowShim)
+ (AVCaptureDevice *)botflow_defaultDeviceWithMediaType:(AVMediaType)mediaType {
  if ([mediaType isEqualToString:AVMediaTypeVideo]) return (AVCaptureDevice *)BFFakeDevice();
  return [self botflow_defaultDeviceWithMediaType:mediaType];
}
+ (AVCaptureDevice *)botflow_defaultDeviceWithDeviceType:(AVCaptureDeviceType)deviceType
                                              mediaType:(AVMediaType)mediaType
                                               position:(AVCaptureDevicePosition)position {
  if ([mediaType isEqualToString:AVMediaTypeVideo]) {
    BFLog(@"defaultDeviceWithDeviceType:%@ position:%ld -> fake", deviceType, (long)position);
    return (AVCaptureDevice *)BFFakeDevice();
  }
  return [self botflow_defaultDeviceWithDeviceType:deviceType mediaType:mediaType position:position];
}
+ (NSArray<AVCaptureDevice *> *)botflow_devicesWithMediaType:(AVMediaType)mediaType {
  if ([mediaType isEqualToString:AVMediaTypeVideo]) return @[(AVCaptureDevice *)BFFakeDevice()];
  return [self botflow_devicesWithMediaType:mediaType];
}
+ (AVAuthorizationStatus)botflow_authorizationStatusForMediaType:(AVMediaType)mediaType {
  BFLog(@"authorizationStatusForMediaType:%@ -> authorized", mediaType);
  return AVAuthorizationStatusAuthorized;
}
+ (void)botflow_requestAccessForMediaType:(AVMediaType)mediaType
                        completionHandler:(void (^)(BOOL))handler {
  if (handler) handler(YES);
}
@end

@implementation AVCaptureDeviceDiscoverySession (BotflowShim)
- (NSArray<AVCaptureDevice *> *)botflow_devices {
  NSArray *real = [self botflow_devices];
  if (real.count > 0) return real;
  return @[(AVCaptureDevice *)BFFakeDevice()];
}
@end

@implementation AVCaptureDeviceInput (BotflowShim)
// Swift's `AVCaptureDeviceInput(device:)` calls THIS initializer, not the factory
// below. The real init rejects our synthetic device (it's not a real
// AVCaptureDevice), so apps doing `guard let input = try? AVCaptureDeviceInput(...)`
// would bail. Intercept it: for the fake device, return self without running the
// real initializer (which would fail). Our addInput: swallows it anyway.
- (instancetype)botflow_initWithDevice:(AVCaptureDevice *)device error:(NSError **)outError {
  if ([device isKindOfClass:[BotflowFakeDevice class]]) {
    BFLog(@"AVCaptureDeviceInput initWithDevice: synthetic device accepted");
    if (outError) *outError = nil;
    return self; // already alloc'd; skip the real init that would reject the fake device
  }
  return [self botflow_initWithDevice:device error:outError];
}
+ (instancetype)botflow_deviceInputWithDevice:(AVCaptureDevice *)device error:(NSError **)outError {
  if ([device isKindOfClass:[BotflowFakeDevice class]]) {
    BFLog(@"AVCaptureDeviceInput deviceInputWithDevice: synthetic device accepted");
    if (outError) *outError = nil;
    return (AVCaptureDeviceInput *)[AVCaptureDeviceInput alloc];
  }
  return [self botflow_deviceInputWithDevice:device error:outError];
}
@end

@implementation AVCaptureSession (BotflowShim)
- (BOOL)botflow_canAddInput:(AVCaptureInput *)input { return YES; }
- (void)botflow_addInput:(AVCaptureInput *)input {
  // Our dummy input has no real ports — never hand it to the real session, which
  // would throw. Real inputs (none, in the simulator) still pass through.
  if ([input isKindOfClass:[AVCaptureDeviceInput class]]) return;
  [self botflow_addInput:input];
}
- (BOOL)botflow_canAddOutput:(AVCaptureOutput *)output { return YES; }
- (void)botflow_addOutput:(AVCaptureOutput *)output {
  if ([output isKindOfClass:[AVCaptureVideoDataOutput class]]) {
    [[BotflowFrameSource shared] registerVideoOutput:(AVCaptureVideoDataOutput *)output];
  }
  // Add real outputs to the real (empty) session too where harmless, so the
  // app's references stay valid. Photo/video data outputs are tracked by us and
  // fed from the fake graph; adding them to an input-less session is a no-op.
  @try { [self botflow_addOutput:output]; } @catch (__unused NSException *e) { /* ignore */ }
}
- (void)botflow_startRunning {
  BFLog(@"AVCaptureSession startRunning (fake graph)");
  [[BotflowFrameSource shared] sessionDidStartRunning];
  // Intentionally do NOT call through — the real session has no working camera.
}
- (void)botflow_stopRunning {
  [[BotflowFrameSource shared] sessionDidStopRunning];
}
@end

@implementation AVCaptureVideoPreviewLayer (BotflowShim)
- (instancetype)botflow_initWithSession:(AVCaptureSession *)session {
  id layer = [self botflow_initWithSession:session];
  if (layer) [[BotflowFrameSource shared] registerPreviewLayer:layer];
  return layer;
}
- (void)botflow_setSession:(AVCaptureSession *)session {
  BFLog(@"AVCaptureVideoPreviewLayer setSession: registering preview layer");
  [self botflow_setSession:session];
  [[BotflowFrameSource shared] registerPreviewLayer:self];
}
@end

@implementation AVCapturePhotoOutput (BotflowShim)
- (void)botflow_capturePhotoWithSettings:(AVCapturePhotoSettings *)settings
                                delegate:(id<AVCapturePhotoCaptureDelegate>)delegate {
  CMSampleBufferRef sample = [[BotflowFrameSource shared] copyLatestSampleBuffer];
  if (!sample) {
    // Nothing to deliver yet — fall back to the real implementation (will likely
    // error in the simulator, but better than silently dropping the callback).
    [self botflow_capturePhotoWithSettings:settings delegate:delegate];
    return;
  }
  // Modern delegate path: didFinishProcessingPhoto: (iOS 11+).
  if ([delegate respondsToSelector:@selector(captureOutput:didFinishProcessingPhoto:error:)]) {
    // Building a fully-formed AVCapturePhoto is not publicly supported; deliver
    // via the sample-buffer path instead which most apps also implement.
  }
  if ([delegate respondsToSelector:@selector(captureOutput:didFinishProcessingPhotoSampleBuffer:previewPhotoSampleBuffer:resolvedSettings:bracketSettings:error:)]) {
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Wdeprecated-declarations"
    AVCaptureResolvedPhotoSettings *resolved = nil;
    [delegate captureOutput:self
        didFinishProcessingPhotoSampleBuffer:sample
                  previewPhotoSampleBuffer:NULL
                          resolvedSettings:resolved
                           bracketSettings:nil
                                     error:nil];
    #pragma clang diagnostic pop
  }
  CFRelease(sample);
}
@end

// ──────────────────────────────────────────────────────────────────────────────
// Entry point — install swizzles as early as possible.
// ──────────────────────────────────────────────────────────────────────────────
__attribute__((constructor))
static void BotflowCameraShimInit(void) {
  @autoreleasepool {
    BFLog(@"Loading (BOTFLOW_CAMERA_URL=%@)",
          [[NSProcessInfo processInfo].environment objectForKey:@"BOTFLOW_CAMERA_URL"] ?: @"(unset)");

    Class dev = [AVCaptureDevice class];
    BFSwizzleClass(dev, @selector(defaultDeviceWithMediaType:), @selector(botflow_defaultDeviceWithMediaType:));
    BFSwizzleClass(dev, @selector(defaultDeviceWithDeviceType:mediaType:position:), @selector(botflow_defaultDeviceWithDeviceType:mediaType:position:));
    BFSwizzleClass(dev, @selector(devicesWithMediaType:), @selector(botflow_devicesWithMediaType:));
    BFSwizzleClass(dev, @selector(authorizationStatusForMediaType:), @selector(botflow_authorizationStatusForMediaType:));
    BFSwizzleClass(dev, @selector(requestAccessForMediaType:completionHandler:), @selector(botflow_requestAccessForMediaType:completionHandler:));

    BFSwizzleInstance([AVCaptureDeviceDiscoverySession class], @selector(devices), @selector(botflow_devices));

    BFSwizzleClass([AVCaptureDeviceInput class], @selector(deviceInputWithDevice:error:), @selector(botflow_deviceInputWithDevice:error:));
    BFSwizzleInstance([AVCaptureDeviceInput class], @selector(initWithDevice:error:), @selector(botflow_initWithDevice:error:));

    Class session = [AVCaptureSession class];
    BFSwizzleInstance(session, @selector(canAddInput:), @selector(botflow_canAddInput:));
    BFSwizzleInstance(session, @selector(addInput:), @selector(botflow_addInput:));
    BFSwizzleInstance(session, @selector(canAddOutput:), @selector(botflow_canAddOutput:));
    BFSwizzleInstance(session, @selector(addOutput:), @selector(botflow_addOutput:));
    BFSwizzleInstance(session, @selector(startRunning), @selector(botflow_startRunning));
    BFSwizzleInstance(session, @selector(stopRunning), @selector(botflow_stopRunning));

    Class preview = [AVCaptureVideoPreviewLayer class];
    BFSwizzleInstance(preview, @selector(initWithSession:), @selector(botflow_initWithSession:));
    BFSwizzleInstance(preview, @selector(setSession:), @selector(botflow_setSession:));

    BFSwizzleInstance([AVCapturePhotoOutput class], @selector(capturePhotoWithSettings:delegate:), @selector(botflow_capturePhotoWithSettings:delegate:));

    BFLog(@"Swizzles installed.");
  }
}
