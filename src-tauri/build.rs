fn main() {
    cc::Build::new()
        .file("native/ocr_bridge.m")
        .file("native/service_bridge.m")
        .file("native/autostart_bridge.m")
        .flag("-fobjc-arc")
        .compile("native_bridge");

    println!("cargo:rustc-link-lib=framework=Vision");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=Quartz");
    println!("cargo:rustc-link-lib=framework=ServiceManagement");

    tauri_build::build();
}
