#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

extern void goSystemResumed(void);

// Observes NSWorkspaceDidWakeNotification, which NSWorkspace's own notification
// center posts when the Mac wakes from sleep. On wake we tell Go so the sidecar
// reconnects its IDLE watchers.
@interface OrenetaResumeObserver : NSObject
@end

@implementation OrenetaResumeObserver
- (void)didWake:(NSNotification *)note {
    goSystemResumed();
}
@end

static OrenetaResumeObserver *orenetaResumeObserver = nil;

void setupResumeObserver() {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (orenetaResumeObserver == nil) {
            orenetaResumeObserver = [[OrenetaResumeObserver alloc] init];
        }
        [[[NSWorkspace sharedWorkspace] notificationCenter]
            addObserver:orenetaResumeObserver
               selector:@selector(didWake:)
                   name:NSWorkspaceDidWakeNotification
                 object:nil];
    });
}

void teardownResumeObserver() {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (orenetaResumeObserver != nil) {
            [[[NSWorkspace sharedWorkspace] notificationCenter]
                removeObserver:orenetaResumeObserver];
        }
    });
}
