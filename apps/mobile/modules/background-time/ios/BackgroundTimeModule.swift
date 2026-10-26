import ExpoModulesCore
import UIKit

/// While a cell runs, ask iOS for background time: an app switched away from (to the pager app,
/// to a chat) is suspended within seconds, which cuts its SSH connection; with a background task
/// iOS lets it run on for about half a minute, enough for most commands to finish.
public class BackgroundTimeModule: Module {
  private var tasks: [Int: UIBackgroundTaskIdentifier] = [:]
  private var next = 1

  public func definition() -> ModuleDefinition {
    Name("BackgroundTime")

    Function("begin") { (name: String) -> Int in
      let id = self.next
      self.next += 1
      // UIKit on the main thread; the tasks table is only touched there.
      let start = {
        let task = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
          // Time is up: end it, as iOS requires (the connection may drop now).
          self?.end(id)
        }
        self.tasks[id] = task
      }
      if Thread.isMainThread { start() } else { DispatchQueue.main.sync(execute: start) }
      return id
    }

    Function("end") { (id: Int) in
      DispatchQueue.main.async { self.end(id) }
    }
  }

  private func end(_ id: Int) {
    guard let task = tasks.removeValue(forKey: id), task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
  }
}
