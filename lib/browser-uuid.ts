export function createUuidV4(): string {
    const cryptoApi = globalThis.crypto;

    if (typeof cryptoApi.randomUUID === "function") {
        return cryptoApi.randomUUID();
    }

    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);

    // UUID version 4.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;

    // UUID RFC 4122 variant.
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(
        bytes,
        (byte) => byte.toString(16).padStart(2, "0"),
    );

    return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join(""),
    ].join("-");
}