import AppKit
import Foundation

// A custom file icon preserves the transparent silhouette on macOS versions
// that place legacy application icons inside a system background tile.
guard CommandLine.arguments.count == 3 else {
    fputs("Usage: apply-macos-icon.swift <app bundle> <icon file>\n", stderr)
    exit(1)
}
let appPath = CommandLine.arguments[1]
let iconPath = CommandLine.arguments[2]
guard let image = NSImage(contentsOfFile: iconPath),
      NSWorkspace.shared.setIcon(image, forFile: appPath, options: []) else {
    fputs("Cannot apply the transparent macOS app icon.\n", stderr)
    exit(1)
}
print("Transparent custom icon applied to \(appPath)")
