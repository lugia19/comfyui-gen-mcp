// The protobuf messages the Worker sends to and reads from Modal's control plane (design §6,
// "Setup without a repository"): only the fields it uses, with Modal's own field numbers. Unknown
// fields are skipped when decoding, which protobuf allows, so the rest of each message can be left
// out. scripts/check_modal_proto.mjs checks every field here against Modal's api.proto.
//
// A small codec instead of generated code: about twenty messages, and nothing to decode when an
// isolate starts (the whole api.proto's descriptor cost the spike up to 17 ms of CPU).

type Scalar = "string" | "bytes" | "bool" | "int32" | "uint32" | "uint64" | "enum" | "float" | "double";
type Kind = Scalar | Schema;
/** [field number, kind, repeated] */
type Field = readonly [number, Kind, boolean?];
export type Schema = { readonly name: string; readonly fields: Readonly<Record<string, Field>> };

const msg = (name: string, fields: Record<string, Field>): Schema => ({ name, fields });

// ── The messages (names and fields as in modal_proto/api.proto) ──

/** map<string, string> travels as repeated entries. */
const StringEntry = msg("map<string,string>", { key: [1, "string"], value: [2, "string"] });
export const Empty = msg("Empty", {});
export const AuthTokenGetResponse = msg("AuthTokenGetResponse", { token: [1, "string"] });
export const TokenFlowCreateRequest = msg("TokenFlowCreateRequest", { utm_source: [3, "string"] });
export const TokenFlowCreateResponse = msg("TokenFlowCreateResponse", {
  token_flow_id: [1, "string"], web_url: [2, "string"], code: [3, "string"], wait_secret: [4, "string"],
});
export const TokenFlowWaitRequest = msg("TokenFlowWaitRequest", { timeout: [1, "float"], token_flow_id: [2, "string"], wait_secret: [3, "string"] });
export const TokenFlowWaitResponse = msg("TokenFlowWaitResponse", {
  token_id: [1, "string"], token_secret: [2, "string"], timeout: [3, "bool"], workspace_username: [4, "string"],
});
export const SecretGetOrCreateRequest = msg("SecretGetOrCreateRequest", {
  deployment_name: [1, "string"], object_creation_type: [4, "enum"], env_dict: [5, StringEntry, true],
});
export const SecretGetOrCreateResponse = msg("SecretGetOrCreateResponse", { secret_id: [1, "string"] });
export const AppGetOrCreateRequest = msg("AppGetOrCreateRequest", { app_name: [1, "string"], object_creation_type: [3, "enum"] });
export const AppGetOrCreateResponse = msg("AppGetOrCreateResponse", { app_id: [1, "string"] });
export const Image = msg("Image", { dockerfile_commands: [6, "string", true] });
export const ImageGetOrCreateRequest = msg("ImageGetOrCreateRequest", { image: [2, Image], app_id: [4, "string"], builder_version: [9, "string"] });
export const GenericResult = msg("GenericResult", { status: [1, "enum"], exception: [2, "string"], exitcode: [3, "int32"] });
export const ImageGetOrCreateResponse = msg("ImageGetOrCreateResponse", { image_id: [1, "string"], result: [2, GenericResult] });
export const ImageJoinStreamingRequest = msg("ImageJoinStreamingRequest", { image_id: [1, "string"], timeout: [2, "float"], last_entry_id: [3, "string"] });
export const TaskLogs = msg("TaskLogs", { data: [1, "string"] });
export const ImageJoinStreamingResponse = msg("ImageJoinStreamingResponse", {
  result: [1, GenericResult], task_logs: [2, TaskLogs, true], entry_id: [3, "string"], eof: [4, "bool"],
});
export const NetworkAccess = msg("NetworkAccess", { network_access_type: [1, "enum"] });
export const Sandbox = msg("Sandbox", {
  entrypoint_args: [1, "string", true], image_id: [3, "string"], secret_ids: [4, "string", true], timeout_secs: [7, "uint32"],
  network_access: [22, NetworkAccess],
});
export const SandboxCreateRequest = msg("SandboxCreateRequest", { app_id: [1, "string"], definition: [2, Sandbox] });
export const SandboxCreateResponse = msg("SandboxCreateResponse", { sandbox_id: [1, "string"] });
export const SandboxGetLogsRequest = msg("SandboxGetLogsRequest", {
  sandbox_id: [1, "string"], file_descriptor: [2, "enum"], timeout: [3, "float"], last_entry_id: [4, "string"],
});
export const TaskLogsBatch = msg("TaskLogsBatch", { items: [2, TaskLogs, true], entry_id: [5, "string"], eof: [14, "bool"] });
export const SandboxWaitRequest = msg("SandboxWaitRequest", { sandbox_id: [1, "string"], timeout: [2, "float"] });
export const SandboxWaitResponse = msg("SandboxWaitResponse", { result: [1, GenericResult] });

/** Enum values used. */
export const CREATE_IF_MISSING = 1;
export const CREATE_OVERWRITE_IF_EXISTS = 3;
export const NETWORK_OPEN = 1;
export const STDOUT = 1;
export const STATUS_SUCCESS = 1;

/** Each message the client uses, for the check against api.proto. */
export const MESSAGES: Schema[] = [
  AuthTokenGetResponse, TokenFlowCreateRequest, TokenFlowCreateResponse, TokenFlowWaitRequest, TokenFlowWaitResponse,
  SecretGetOrCreateRequest, SecretGetOrCreateResponse, AppGetOrCreateRequest, AppGetOrCreateResponse, Image,
  ImageGetOrCreateRequest, GenericResult, ImageGetOrCreateResponse, ImageJoinStreamingRequest, TaskLogs,
  ImageJoinStreamingResponse, NetworkAccess, Sandbox, SandboxCreateRequest, SandboxCreateResponse, SandboxGetLogsRequest,
  TaskLogsBatch, SandboxWaitRequest, SandboxWaitResponse,
];

// ── The codec ──

class Writer {
  private parts: number[] = [];
  varint(v: bigint) {
    v = BigInt.asUintN(64, v);
    while (v > 0x7fn) {
      this.parts.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.parts.push(Number(v));
  }
  tag(num: number, wire: number) {
    this.varint(BigInt((num << 3) | wire));
  }
  raw(bytes: Uint8Array) {
    this.varint(BigInt(bytes.length));
    for (const b of bytes) this.parts.push(b);
  }
  fixed(bytes: Uint8Array) {
    for (const b of bytes) this.parts.push(b);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function writeValue(w: Writer, num: number, kind: Kind, v: any) {
  if (typeof kind === "object") {
    w.tag(num, 2);
    w.raw(encode(kind, v));
  } else if (kind === "string") {
    w.tag(num, 2);
    w.raw(utf8.encode(v));
  } else if (kind === "bytes") {
    w.tag(num, 2);
    w.raw(v);
  } else if (kind === "float") {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    w.tag(num, 5);
    w.fixed(b);
  } else if (kind === "double") {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    w.tag(num, 1);
    w.fixed(b);
  } else {
    w.tag(num, 0);
    w.varint(BigInt(kind === "bool" ? (v ? 1 : 0) : v));
  }
}

const isDefault = (v: unknown) => v === undefined || v === null || v === "" || v === 0 || v === false;

/** *value*'s fields as *schema* says; defaults and fields not in the schema are left out. A map
 * field takes a plain object. */
export function encode(schema: Schema, value: Record<string, any>): Uint8Array {
  const w = new Writer();
  for (const [name, [num, kind, repeated]] of Object.entries(schema.fields)) {
    let v = value[name];
    if (kind === StringEntry && v && !Array.isArray(v)) v = Object.entries(v).map(([key, value]) => ({ key, value }));
    if (repeated) for (const item of v ?? []) writeValue(w, num, kind, item);
    else if (!isDefault(v)) writeValue(w, num, kind, v);
  }
  return w.done();
}

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  varint(): bigint {
    let v = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (this.pos >= this.buf.length) throw new Error("protobuf: truncated varint");
      const b = this.buf[this.pos++];
      v |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return v;
    }
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("protobuf: truncated field");
    return this.buf.subarray(this.pos, (this.pos += n));
  }
}

function readValue(r: Reader, wire: number, kind: Kind): unknown {
  if (typeof kind === "object") return decode(kind, r.take(Number(r.varint())));
  if (kind === "string") return fromUtf8.decode(r.take(Number(r.varint())));
  if (kind === "bytes") return r.take(Number(r.varint())).slice();
  if (kind === "float" || kind === "double") {
    const b = r.take(kind === "float" ? 4 : 8);
    const view = new DataView(b.buffer, b.byteOffset, b.length);
    return kind === "float" ? view.getFloat32(0, true) : view.getFloat64(0, true);
  }
  if (wire !== 0) throw new Error(`protobuf: unexpected wire type ${wire}`);
  const v = r.varint();
  if (kind === "bool") return v !== 0n;
  if (kind === "int32") return Number(BigInt.asIntN(32, v));
  if (kind === "uint64") return v.toString();
  return Number(v);
}

function skip(r: Reader, wire: number) {
  if (wire === 0) r.varint();
  else if (wire === 1) r.take(8);
  else if (wire === 2) r.take(Number(r.varint()));
  else if (wire === 5) r.take(4);
  else throw new Error(`protobuf: unsupported wire type ${wire}`);
}

/** The fields *schema* knows, from *bytes*; repeated fields are arrays (empty when absent). */
export function decode<T = Record<string, any>>(schema: Schema, bytes: Uint8Array): T {
  const byNum = new Map<number, [string, Kind, boolean]>();
  const out: Record<string, any> = {};
  for (const [name, [num, kind, repeated]] of Object.entries(schema.fields)) {
    byNum.set(num, [name, kind, Boolean(repeated)]);
    if (repeated) out[name] = [];
  }
  const r = new Reader(bytes);
  while (r.pos < bytes.length) {
    const key = Number(r.varint());
    const [num, wire] = [key >>> 3, key & 7];
    const field = byNum.get(num);
    if (!field) {
      skip(r, wire);
      continue;
    }
    const [name, kind, repeated] = field;
    const v = readValue(r, wire, kind);
    if (repeated) out[name].push(v);
    else out[name] = v;
  }
  return out as T;
}
