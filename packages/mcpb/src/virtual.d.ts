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
