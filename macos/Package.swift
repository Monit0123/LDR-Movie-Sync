// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "FlickSync",
    platforms: [.macOS(.v12)],
    products: [
        .executable(name: "FlickSync", targets: ["FlickSync"]),
    ],
    targets: [
        .executableTarget(
            name: "FlickSync",
            path: "Sources/LDRSync"
        ),
    ]
)
