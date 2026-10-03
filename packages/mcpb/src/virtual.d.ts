// Modules build.mjs generates for the bundle.
declare module "comfy-gen:web" {
  const files: Record<string, { type: string; body: string }>;
  export default files;
}
declare module "comfy-gen:wait-extension" {
  const source: string;
  export default source;
}
declare module "comfy-gen:icons" {
  const icons: Record<"yellow" | "green" | "red", { ico: string; png: string }>; // base64
  export default icons;
}
declare module "comfy-gen:tray" {
  // The tray helpers built for this release, by platform (windows, linux, macos); none in a dev build.
  const helpers: Record<string, { name: string; sha256: string }>;
  export default helpers;
}
