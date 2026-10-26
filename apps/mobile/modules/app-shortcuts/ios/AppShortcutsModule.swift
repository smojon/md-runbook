import ExpoModulesCore
import UIKit

/// The app icon's quick actions (long press): each carries a route of the app ("/scan",
/// "/runbook/ID"). A quick action that starts the app arrives before JavaScript runs, so its route
/// is kept for takeLaunchPath(); one tapped while the app runs opens as an mdrunbook:// link.
public class AppShortcutsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppShortcuts")

    Function("setShortcuts") { (items: [[String: String]]) in
      let shortcuts: [UIApplicationShortcutItem] = items.prefix(4).compactMap { item in
        guard let id = item["id"], let title = item["title"], let path = item["path"] else { return nil }
        return UIApplicationShortcutItem(
          type: id,
          localizedTitle: title,
          localizedSubtitle: nil,
          icon: UIApplicationShortcutIcon(systemImageName: item["icon"] ?? "doc.text"),
          userInfo: ["path": path as NSString]
        )
      }
      DispatchQueue.main.async { UIApplication.shared.shortcutItems = shortcuts }
    }

    Function("takeLaunchPath") { () -> String? in
      AppShortcutsAppDelegate.takePending()
    }
  }
}

public class AppShortcutsAppDelegate: ExpoAppDelegateSubscriber {
  private static var pending: String?
  private static var started = false
  private static let lock = NSLock()

  static func takePending() -> String? {
    lock.lock()
    defer { lock.unlock() }
    started = true
    let path = pending
    pending = nil
    return path
  }

  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard let path = shortcutItem.userInfo?["path"] as? String else { return completionHandler(false) }
    Self.lock.lock()
    let running = Self.started
    if !running { Self.pending = path }
    Self.lock.unlock()
    if running, let url = URL(string: "mdrunbook:/" + path) {
      DispatchQueue.main.async { UIApplication.shared.open(url) }
    }
    completionHandler(true)
  }
}
