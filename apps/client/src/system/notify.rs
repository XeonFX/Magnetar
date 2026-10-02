//! Notifications from the operating system itself, with buttons: Notification Center on macOS, a
//! toast on Windows, the desktop's notification server on Linux (`notify-send`). For news about the
//! app itself, such as a new version, which must reach someone with no dashboard open; the channels
//! in `notifications.rs` stay what people choose for their downloads.
//!
//! Best effort everywhere: where the system has nowhere to show one (a server, a dev build outside
//! the .app, notifications turned off for Magnetar), nothing shows and the reason is logged.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

/// What the person did with a notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    /// Clicked the notice itself.
    Open,
    /// Clicked the button with this id.
    Action(&'static str),
}

/// A notice to show.
pub struct Notice {
    /// Notices of one kind share it; a newer one replaces the older where the system can.
    pub kind: &'static str,
    pub title: String,
    pub body: String,
    /// Buttons, by id and label, in order.
    pub actions: Buttons,
}

type Handler = Arc<dyn Fn(Choice) + Send + Sync>;
/// A notice's buttons, by id and label.
type Buttons = Vec<(&'static str, String)>;

/// The buttons notices of a kind may carry, and what choosing does.
type Listener = (Vec<&'static str>, Handler);

/// What notices do when chosen, by kind (a notice's id is its kind's): registered before any is
/// shown, so a notice still on screen from the app's last run is answered too.
static HANDLERS: LazyLock<Mutex<HashMap<String, Listener>>> = LazyLock::new(Mutex::default);

fn notice_id(kind: &str) -> String {
    format!("cc.codefusion.magnetar.{kind}")
}

/// Runs the handler of the notice `id` for a choice the system reported as an action id: the
/// notice's own buttons, anything else (the system's default action) as a click on the notice.
fn chosen(id: &str, action: Option<&str>) {
    let Some((actions, handler)) = HANDLERS.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned() else {
        return;
    };
    let choice = action.and_then(|action| actions.iter().find(|a| **a == action)).map_or(Choice::Open, |a| Choice::Action(a));
    handler(choice);
}

/// Registers what notices of `kind` do when chosen, with every button one may carry (id and
/// label), before any is shown: `on_choice` runs, on some thread, when the person clicks one or one
/// of its buttons, also on a notice left from the app's last run. Readies the system's side too
/// (macOS: who answers clicks, and the buttons; Windows: the app id the toasts show).
pub fn listen(kind: &'static str, buttons: &[(&'static str, &str)], on_choice: impl Fn(Choice) + Send + Sync + 'static) {
    let id = notice_id(kind);
    let actions = buttons.iter().map(|(action, _)| *action).collect();
    HANDLERS.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), (actions, Arc::new(on_choice)));
    platform::prepare(&id, buttons);
}

/// Shows `notice`; choosing it does what `listen` registered for its kind.
pub fn show(notice: Notice) {
    platform::show(&notice_id(notice.kind), &notice);
}

#[cfg(target_os = "macos")]
mod platform {
    //! UserNotifications. It needs the app's bundle: outside Magnetar.app (a dev build) the
    //! framework aborts the process, so there a plain AppleScript notice stands in, without buttons.
    //! It also refuses an app that is only ad-hoc signed (a release built without the Developer ID
    //! certificate): there the older NSUserNotification shows it, with its button.

    use std::sync::{Mutex, OnceLock};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, ProtocolObject};
    use objc2::{AnyThread, define_class, msg_send};
    #[allow(deprecated)]
    use objc2_foundation::{
        NSArray, NSError, NSObjectProtocol, NSSet, NSString, NSUserNotification, NSUserNotificationActivationType,
        NSUserNotificationCenter, NSUserNotificationCenterDelegate,
    };
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction, UNNotificationActionOptions,
        UNNotificationCategory, UNNotificationCategoryOptions, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    use super::Notice;

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MagnetarNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// A menu-bar app counts as in front: show the banner anyway.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let id = response.notification().request().identifier().to_string();
                let action = response.actionIdentifier().to_string();
                // Dismissing is no choice; the default action is a click on the notice.
                if action != "com.apple.UNNotificationDismissActionIdentifier" {
                    super::chosen(&id, Some(&action));
                }
                handler.call(());
            }
        }
    );

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MagnetarLegacyNotificationDelegate"]
        struct LegacyDelegate;

        unsafe impl NSObjectProtocol for LegacyDelegate {}

        #[allow(deprecated)]
        unsafe impl NSUserNotificationCenterDelegate for LegacyDelegate {
            /// A menu-bar app counts as in front: show the banner anyway.
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(&self, _center: &NSUserNotificationCenter, _notification: &NSUserNotification) -> bool {
                true
            }

            /// The notice's identifier is its id, then `#` and the action its one button does.
            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(&self, _center: &NSUserNotificationCenter, notification: &NSUserNotification) {
                let Some(identifier) = notification.identifier().map(|id| id.to_string()) else { return };
                let (id, button) = identifier.split_once('#').map_or((identifier.as_str(), None), |(id, b)| (id, Some(b)));
                let activation = notification.activationType();
                if activation == NSUserNotificationActivationType::ActionButtonClicked {
                    super::chosen(id, button);
                } else if activation == NSUserNotificationActivationType::ContentsClicked {
                    super::chosen(id, None);
                }
            }
        }
    );

    /// The delegates, kept for the process's life: the centers hold them weakly.
    struct Kept<T>(#[allow(dead_code)] Retained<T>);
    // SAFETY: the delegates have no state; the frameworks call them from their own queue.
    unsafe impl<T> Send for Kept<T> {}
    unsafe impl<T> Sync for Kept<T> {}
    static DELEGATE: OnceLock<Kept<Delegate>> = OnceLock::new();
    static LEGACY_DELEGATE: OnceLock<Kept<LegacyDelegate>> = OnceLock::new();
    /// The categories registered so far, one per button (`<id>.<action>`); setting them replaces
    /// the whole set, so all are set each time.
    static CATEGORIES: Mutex<Vec<(String, (&'static str, String))>> = Mutex::new(Vec::new());

    /// The category of a notice with this one button.
    fn category(id: &str, action: &str) -> String {
        format!("{id}.{action}")
    }

    /// Sets who answers clicks on both APIs, and the buttons notices of `id` may carry, at start-up:
    /// macOS applies categories in the background, so registered at the first notice its button
    /// could be missing.
    #[allow(deprecated)]
    pub fn prepare(id: &str, buttons: &[(&'static str, &str)]) {
        if crate::paths::mac_app_bundle().is_none() {
            return;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        DELEGATE.get_or_init(|| {
            let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            Kept(delegate)
        });
        LEGACY_DELEGATE.get_or_init(|| {
            let delegate: Retained<LegacyDelegate> = unsafe { msg_send![LegacyDelegate::alloc(), init] };
            // SAFETY: the delegate lives as long as the process (LEGACY_DELEGATE).
            unsafe {
                NSUserNotificationCenter::defaultUserNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)))
            };
            Kept(delegate)
        });
        register_categories(
            &center,
            buttons.iter().map(|(action, label)| (category(id, action), (*action, (*label).to_owned()))),
        );
    }

    pub fn show(id: &str, notice: &Notice) {
        if crate::paths::mac_app_bundle().is_none() {
            return applescript(notice);
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let button = notice.actions.first().cloned();
        if let Some((action, label)) = &button {
            register_categories(&center, [(category(id, action), (*action, label.clone()))].into_iter());
        }
        let (id, title, body) = (id.to_owned(), notice.title.clone(), notice.body.clone());
        // The first time, macOS asks the person whether Magnetar may notify; later this answers at once.
        let post = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if !granted.as_bool() {
                match unsafe { error.as_ref() } {
                    // The system refuses this copy of the app as signed, not the person: the older API still shows it.
                    Some(error) => {
                        tracing::info!("UserNotifications refused ({}); using NSUserNotification", error.localizedDescription());
                        legacy(&id, &title, &body, button.clone());
                    }
                    None => tracing::info!("Notification not shown: turned off in System Settings"),
                }
                return;
            }
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&title));
            content.setBody(&NSString::from_str(&body));
            if let Some((action, _)) = &button {
                content.setCategoryIdentifier(&NSString::from_str(&category(&id, action)));
            }
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
            let added = RcBlock::new(|error: *mut NSError| {
                if let Some(error) = unsafe { error.as_ref() } {
                    tracing::warn!("Notification not shown: {}", error.localizedDescription());
                }
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&added));
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &post,
        );
    }

    #[allow(deprecated)]
    fn legacy(id: &str, title: &str, body: &str, button: Option<(&'static str, String)>) {
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        let notification = NSUserNotification::new();
        // Its one button's action rides in the identifier, so a click after a restart still knows it.
        let identifier = button.as_ref().map_or(id.to_owned(), |(action, _)| format!("{id}#{action}"));
        notification.setIdentifier(Some(&NSString::from_str(&identifier)));
        notification.setTitle(Some(&NSString::from_str(title)));
        notification.setInformativeText(Some(&NSString::from_str(body)));
        notification.setSoundName(Some(&NSString::from_str("NSUserNotificationDefaultSoundName")));
        match button {
            Some((_, label)) => {
                notification.setHasActionButton(true);
                notification.setActionButtonTitle(&NSString::from_str(&label));
            }
            None => notification.setHasActionButton(false),
        }
        // A newer notice of the kind replaces the older, whatever its button was.
        let of_kind = |n: &NSUserNotification| n.identifier().is_some_and(|i| i.to_string().split('#').next() == Some(id));
        for old in center.deliveredNotifications().iter().filter(|n| of_kind(n)) {
            center.removeDeliveredNotification(&old);
        }
        center.deliverNotification(&notification);
        // macOS keeps one it won't show (turned off for Magnetar) out of the delivered list.
        let listed = center.deliveredNotifications().iter().any(|n| n.identifier().is_some_and(|i| i.to_string() == identifier));
        if listed {
            tracing::info!("Notification shown");
        } else {
            tracing::info!("Notification not shown: turned off for Magnetar in System Settings");
        }
    }

    fn register_categories(center: &UNUserNotificationCenter, wanted: impl Iterator<Item = (String, (&'static str, String))>) {
        let mut categories = CATEGORIES.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        for (category, button) in wanted {
            if !categories.iter().any(|(known, b)| *known == category && *b == button) {
                categories.retain(|(known, _)| *known != category);
                categories.push((category, button));
                changed = true;
            }
        }
        if !changed {
            return;
        }
        let set: Vec<Retained<UNNotificationCategory>> = categories
            .iter()
            .map(|(category, (action, label))| {
                let button = UNNotificationAction::actionWithIdentifier_title_options(
                    &NSString::from_str(action),
                    &NSString::from_str(label),
                    UNNotificationActionOptions::empty(),
                );
                UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                    &NSString::from_str(category),
                    &NSArray::from_retained_slice(&[button]),
                    &NSArray::new(),
                    UNNotificationCategoryOptions::empty(),
                )
            })
            .collect();
        center.setNotificationCategories(&NSSet::from_retained_slice(&set));
    }

    /// A notice without buttons, for a build running outside Magnetar.app.
    fn applescript(notice: &Notice) {
        let quote = |text: &str| format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""));
        let script = format!("display notification {} with title {}", quote(&notice.body), quote(&notice.title));
        if let Err(error) = crate::system::run_captured("/usr/bin/osascript", &["-e", &script]) {
            tracing::warn!("Notification not shown: {error}");
        }
    }
}

#[cfg(windows)]
mod platform {
    //! A toast. Windows shows toasts of a registered app id; an app that isn't installed through the
    //! Store registers its own under HKCU, once, with the name the toast shows.

    use std::sync::{LazyLock, Mutex};

    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager};
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW};
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    use windows::core::{HSTRING, IInspectable, Interface, w};

    use super::Notice;

    const APP_ID: &str = "CodeFusion.Magnetar";

    /// Registers the app id once; false when Windows refused, and toasts can't show.
    static REGISTERED: LazyLock<bool> = LazyLock::new(|| {
        let name: Vec<u16> = "Magnetar".encode_utf16().chain([0]).collect();
        // SAFETY: the value is a NUL-terminated UTF-16 string of the length given.
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Classes\\AppUserModelId\\CodeFusion.Magnetar"),
                w!("DisplayName"),
                REG_SZ.0,
                Some(name.as_ptr().cast()),
                (name.len() * 2) as u32,
            )
        };
        if status.is_err() {
            tracing::warn!("Could not register for notifications: {status:?}");
            return false;
        }
        // SAFETY: a static string; it only labels this process for the shell.
        let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(w!("CodeFusion.Magnetar")) };
        true
    });

    /// The toasts on screen: Windows calls their handlers only while they live.
    static SHOWN: Mutex<Vec<(String, ToastNotification)>> = Mutex::new(Vec::new());

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
    }

    /// Registers the app id now: Windows wants a process's id set before it shows any window or icon.
    pub fn prepare(_id: &str, _buttons: &[(&'static str, &str)]) {
        LazyLock::force(&REGISTERED);
    }

    pub fn show(id: &str, notice: &Notice) {
        if !*REGISTERED {
            return;
        }
        if let Err(error) = toast(id, notice) {
            tracing::warn!("Notification not shown: {error}");
        }
    }

    fn toast(id: &str, notice: &Notice) -> windows::core::Result<()> {
        let buttons: String = notice
            .actions
            .iter()
            .map(|(action, label)| format!(r#"<action content="{}" arguments="{}"/>"#, escape(label), escape(action)))
            .collect();
        let xml = format!(
            r#"<toast launch="open"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual><actions>{buttons}</actions></toast>"#,
            escape(&notice.title),
            escape(&notice.body),
        );
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        let key = id.to_owned();
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
            let arguments = args.as_ref().and_then(|a| a.cast::<ToastActivatedEventArgs>().ok()).and_then(|a| a.Arguments().ok());
            let action = arguments.map(|a| a.to_string());
            super::chosen(&key, action.as_deref().filter(|a| *a != "open"));
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?.Show(&toast)?;
        let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
        shown.retain(|(other, _)| other != id);
        shown.push((id.to_owned(), toast));
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    //! `notify-send` from libnotify, which every desktop's notification server answers. With
    //! `--action` (libnotify 0.7.9 and later) it waits and prints the button chosen.

    use std::process::{Command, Output, Stdio};

    use super::Notice;

    pub fn prepare(_id: &str, _buttons: &[(&'static str, &str)]) {}

    fn send(notice: &Notice, buttons: bool) -> std::io::Result<Output> {
        let mut command = Command::new("notify-send");
        command.arg("--app-name=Magnetar").arg("--icon=download");
        if buttons {
            command.arg("--action=default=Open");
            for (action, label) in &notice.actions {
                command.arg(format!("--action={action}={label}"));
            }
        }
        command.arg("--").arg(&notice.title).arg(&notice.body).stdin(Stdio::null()).stderr(Stdio::null()).output()
    }

    pub fn show(id: &str, notice: &Notice) {
        let (id, notice) = (
            id.to_owned(),
            Notice { kind: notice.kind, title: notice.title.clone(), body: notice.body.clone(), actions: notice.actions.clone() },
        );
        // A thread of its own: it waits until the notice is chosen or goes away.
        std::thread::spawn(move || match send(&notice, true) {
            Ok(output) if output.status.success() => {
                let action = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if !action.is_empty() {
                    super::chosen(&id, Some(&action).filter(|a| *a != "default").map(String::as_str));
                }
            }
            // A libnotify older than --action refuses it: the notice without buttons still says it.
            Ok(_) => {
                if !send(&notice, false).is_ok_and(|output| output.status.success()) {
                    tracing::info!("Notification not shown: notify-send failed");
                }
            }
            Err(error) => tracing::info!("Notification not shown: notify-send is not available ({error})"),
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn a_choice_reaches_the_notice_it_was_made_on() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = |seen: &Arc<Mutex<Vec<(&'static str, Choice)>>>, name: &'static str| {
            let seen = seen.clone();
            move |choice| seen.lock().unwrap().push((name, choice))
        };
        HANDLERS.lock().unwrap().insert(notice_id("test-a"), (vec!["install"], Arc::new(record(&seen, "a"))));
        HANDLERS.lock().unwrap().insert(notice_id("test-b"), (vec![], Arc::new(record(&seen, "b"))));
        chosen(&notice_id("test-a"), Some("install"));
        // The system's default action, or a button the notice never had, is a click on the notice.
        chosen(&notice_id("test-a"), Some("com.apple.UNNotificationDefaultActionIdentifier"));
        chosen(&notice_id("test-a"), Some("uninstall"));
        chosen(&notice_id("test-b"), None);
        // A notice this process didn't show (one left from before a restart) does nothing.
        chosen(&notice_id("test-gone"), Some("install"));
        assert_eq!(
            *seen.lock().unwrap(),
            [("a", Choice::Action("install")), ("a", Choice::Open), ("a", Choice::Open), ("b", Choice::Open)]
        );
    }

    #[test]
    fn a_newer_notice_of_a_kind_replaces_what_the_older_did() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        for version in ["1.2.0", "1.3.0"] {
            let seen = seen.clone();
            HANDLERS
                .lock()
                .unwrap()
                .insert(notice_id("test-update"), (vec!["install"], Arc::new(move |_| seen.lock().unwrap().push(version))));
        }
        chosen(&notice_id("test-update"), Some("install"));
        assert_eq!(*seen.lock().unwrap(), ["1.3.0"]);
    }
}
