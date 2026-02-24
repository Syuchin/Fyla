#import <ServiceManagement/ServiceManagement.h>
#import <Foundation/Foundation.h>

// macOS 13+ uses SMAppService for login items
int autostart_enable(void) {
    if (@available(macOS 13.0, *)) {
        NSError *error = nil;
        BOOL success = [SMAppService.mainAppService registerAndReturnError:&error];
        if (!success) {
            NSLog(@"[Fyla] autostart enable failed: %@", error);
            return 1;
        }
        return 0;
    }
    return 1;
}

int autostart_disable(void) {
    if (@available(macOS 13.0, *)) {
        NSError *error = nil;
        BOOL success = [SMAppService.mainAppService unregisterAndReturnError:&error];
        if (!success) {
            NSLog(@"[Fyla] autostart disable failed: %@", error);
            return 1;
        }
        return 0;
    }
    return 1;
}

int autostart_is_enabled(void) {
    if (@available(macOS 13.0, *)) {
        return SMAppService.mainAppService.status == SMAppServiceStatusEnabled ? 1 : 0;
    }
    return 0;
}
