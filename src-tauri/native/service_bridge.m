#import <AppKit/AppKit.h>

// ── Global callback function pointer, injected from Rust ──
typedef void (*FylaFilesCallback)(const char* json_paths);
static FylaFilesCallback g_callback = NULL;

void set_files_callback(FylaFilesCallback cb) {
    g_callback = cb;
}

// ── Service Provider ──
@interface FylaServiceProvider : NSObject
- (void)handleFilesFromFinder:(NSPasteboard *)pboard
                     userData:(NSString *)userData
                        error:(NSString **)error;
@end

@implementation FylaServiceProvider

- (void)handleFilesFromFinder:(NSPasteboard *)pboard
                     userData:(NSString *)userData
                        error:(NSString **)error {
    NSArray<NSURL *> *urls = [pboard readObjectsForClasses:@[[NSURL class]]
                                                   options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
    if (!urls.count) {
        if (error) *error = @"No files received";
        return;
    }

    NSMutableArray *paths = [NSMutableArray array];
    for (NSURL *url in urls) {
        if (url.path) {
            [paths addObject:url.path];
        }
    }

    NSData *data = [NSJSONSerialization dataWithJSONObject:paths options:0 error:nil];
    if (!data) return;
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];

    if (g_callback && json) {
        g_callback([json UTF8String]);
    }

    // Bring app to front
    [NSApp activateIgnoringOtherApps:YES];
}

@end

// ── Registration entry point, called once from Rust at startup ──
void register_services_provider(void) {
    static FylaServiceProvider *provider = nil;
    if (!provider) {
        provider = [[FylaServiceProvider alloc] init];
        [NSApp setServicesProvider:provider];
        NSUpdateDynamicServices();
    }
}
