import ExpoModulesCore
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Opens a runbook in place with the document picker and keeps a security-scoped bookmark, so the
/// app can save the runbook back to the same file later, also after a restart.
public final class DocumentAccessModule: Module {
  private var pickerDelegate: PickerDelegate?

  public func definition() -> ModuleDefinition {
    Name("DocumentAccess")

    AsyncFunction("pick") { (promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("E_NO_VIEW", "No screen to show the file picker on")
        return
      }
      var types: [UTType] = [.plainText, .text]
      for ext in ["md", "markdown"] {
        if let t = UTType(filenameExtension: ext) { types.insert(t, at: 0) }
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
      picker.allowsMultipleSelection = false
      let delegate = PickerDelegate { [weak self] url in
        self?.pickerDelegate = nil
        guard let url else {
          promise.resolve(nil)
          return
        }
        do {
          let (text, bookmark) = try DocumentStore.open(url)
          promise.resolve(["name": url.lastPathComponent, "text": text, "bookmark": bookmark])
        } catch {
          promise.reject("E_OPEN", "The file could not be opened: \(error.localizedDescription)")
        }
      }
      self.pickerDelegate = delegate
      picker.delegate = delegate
      presenter.present(picker, animated: true)
    }.runOnQueue(.main)

    AsyncFunction("read") { (bookmark: String) -> [String: Any] in
      let (url, fresh) = try DocumentStore.resolve(bookmark)
      let text = try DocumentStore.withAccess(url) { try DocumentStore.coordinatedRead(url) }
      var result: [String: Any] = ["text": text]
      if let fresh { result["bookmark"] = fresh }
      return result
    }

    AsyncFunction("write") { (bookmark: String, text: String) in
      let (url, _) = try DocumentStore.resolve(bookmark)
      try DocumentStore.withAccess(url) { try DocumentStore.coordinatedWrite(url, text) }
    }
  }
}

private final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
  private let done: (URL?) -> Void
  init(done: @escaping (URL?) -> Void) { self.done = done }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    done(urls.first)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    done(nil)
  }
}

struct DocumentAccessError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

enum DocumentStore {
  /// Larger files are refused (the app keeps runbooks in memory).
  static let maxBytes = 2_000_000

  static func open(_ url: URL) throws -> (String, String) {
    try withAccess(url) {
      let text = try coordinatedRead(url)
      let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      return (text, data.base64EncodedString())
    }
  }

  /// The URL of a bookmark, and a new bookmark when the old one is stale (the file moved).
  static func resolve(_ bookmark: String) throws -> (URL, String?) {
    guard let data = Data(base64Encoded: bookmark) else { throw DocumentAccessError(message: "not a bookmark") }
    var stale = false
    let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    if !stale { return (url, nil) }
    let fresh = try withAccess(url) { try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) }
    return (url, fresh.base64EncodedString())
  }

  static func withAccess<T>(_ url: URL, _ body: () throws -> T) throws -> T {
    let started = url.startAccessingSecurityScopedResource()
    defer { if started { url.stopAccessingSecurityScopedResource() } }
    return try body()
  }

  static func coordinatedRead(_ url: URL) throws -> String {
    var coordinationError: NSError?
    var result: Result<String, Error> = .failure(DocumentAccessError(message: "not read"))
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { u in
      result = Result {
        let data = try Data(contentsOf: u)
        if data.count > maxBytes { throw DocumentAccessError(message: "larger than 2 MB") }
        guard let text = String(data: data, encoding: .utf8) else { throw DocumentAccessError(message: "not UTF-8 text") }
        return text
      }
    }
    if let coordinationError { throw coordinationError }
    return try result.get()
  }

  static func coordinatedWrite(_ url: URL, _ text: String) throws {
    var coordinationError: NSError?
    var failure: Error?
    NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { u in
      do { try Data(text.utf8).write(to: u, options: .atomic) } catch { failure = error }
    }
    if let coordinationError { throw coordinationError }
    if let failure { throw failure }
  }
}
