#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Vision/Vision.h>
#import <Quartz/Quartz.h>
#import <ServiceManagement/ServiceManagement.h>

// --- OCR ---

// OCR 识别图片文件中的文本
char* recognize_text_from_path(const char* path) {
    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        NSImage *image = [[NSImage alloc] initWithContentsOfFile:filePath];
        if (!image) return strdup("");

        CGImageRef cgImage = [image CGImageForProposedRect:nil context:nil hints:nil];
        if (!cgImage) return strdup("");

        __block NSString *resultText = @"";
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);

        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc]
            initWithCompletionHandler:^(VNRequest *req, __unused NSError *error) {
                NSArray<VNRecognizedTextObservation *> *observations = req.results;
                NSMutableArray *lines = [NSMutableArray array];
                for (VNRecognizedTextObservation *obs in observations) {
                    VNRecognizedText *candidate = [[obs topCandidates:1] firstObject];
                    if (candidate) [lines addObject:candidate.string];
                }
                resultText = [lines componentsJoinedByString:@"\n"];
                dispatch_semaphore_signal(sem);
            }];

        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.recognitionLanguages = @[@"zh-Hans", @"zh-Hant", @"en"];
        request.usesLanguageCorrection = YES;

        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc]
            initWithCGImage:cgImage options:@{}];
        [handler performRequests:@[request] error:nil];
        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

        return strdup([resultText UTF8String]);
    }
}

// 将 PDF 首页渲染为 CGImage 并 OCR
char* recognize_text_from_pdf(const char* path) {
    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        PDFDocument *doc = [[PDFDocument alloc] initWithURL:fileURL];
        if (!doc || doc.pageCount == 0) return strdup("");

        PDFPage *page = [doc pageAtIndex:0];
        NSRect bounds = [page boundsForBox:kPDFDisplayBoxMediaBox];

        CGFloat scale = 2.0;
        NSInteger width = (NSInteger)(bounds.size.width * scale);
        NSInteger height = (NSInteger)(bounds.size.height * scale);

        // 使用 CGBitmapContext 渲染 PDF 页面
        CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
        CGContextRef ctx = CGBitmapContextCreate(NULL, width, height, 8, width * 4,
            colorSpace, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
        CGColorSpaceRelease(colorSpace);
        if (!ctx) return strdup("");

        CGContextScaleCTM(ctx, scale, scale);
        CGPDFDocumentRef pdfDoc = CGPDFDocumentCreateWithURL((__bridge CFURLRef)fileURL);
        if (pdfDoc) {
            CGPDFPageRef pdfPage = CGPDFDocumentGetPage(pdfDoc, 1);
            if (pdfPage) {
                CGContextDrawPDFPage(ctx, pdfPage);
            }
            CGPDFDocumentRelease(pdfDoc);
        }

        CGImageRef cgImage = CGBitmapContextCreateImage(ctx);
        CGContextRelease(ctx);
        if (!cgImage) return strdup("");

        __block NSString *resultText = @"";
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);

        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc]
            initWithCompletionHandler:^(VNRequest *req, __unused NSError *error) {
                NSArray<VNRecognizedTextObservation *> *observations = req.results;
                NSMutableArray *lines = [NSMutableArray array];
                for (VNRecognizedTextObservation *obs in observations) {
                    VNRecognizedText *candidate = [[obs topCandidates:1] firstObject];
                    if (candidate) [lines addObject:candidate.string];
                }
                resultText = [lines componentsJoinedByString:@"\n"];
                dispatch_semaphore_signal(sem);
            }];

        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.recognitionLanguages = @[@"zh-Hans", @"zh-Hant", @"en"];
        request.usesLanguageCorrection = YES;

        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc]
            initWithCGImage:cgImage options:@{}];
        [handler performRequests:@[request] error:nil];
        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

        CGImageRelease(cgImage);
        return strdup([resultText UTF8String]);
    }
}

// --- Autostart (SMAppService, macOS 13+) ---

int autostart_enable(void) {
    if (@available(macOS 13.0, *)) {
        SMAppService *service = [SMAppService mainAppService];
        NSError *error = nil;
        BOOL success = [service registerAndReturnError:&error];
        return success ? 0 : -1;
    }
    return -1;
}

int autostart_disable(void) {
    if (@available(macOS 13.0, *)) {
        SMAppService *service = [SMAppService mainAppService];
        NSError *error = nil;
        BOOL success = [service unregisterAndReturnError:&error];
        return success ? 0 : -1;
    }
    return -1;
}

int autostart_is_enabled(void) {
    if (@available(macOS 13.0, *)) {
        SMAppService *service = [SMAppService mainAppService];
        return (service.status == SMAppServiceStatusEnabled) ? 1 : 0;
    }
    return 0;
}
