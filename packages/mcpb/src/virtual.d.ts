// Modules build.mjs generates for the server bundle.
declare module "comfy-gen:web" {
  const files: Record<string, { type: string; body: string }>;
  export default files;
}
declare module "comfy-gen:wait-extension" {
  const source: string;
  export default source;
}
declare module "comfy-gen:icons" {
  export const icoIcon: Uint8Array;
  export const pngIcon: Uint8Array;
}
