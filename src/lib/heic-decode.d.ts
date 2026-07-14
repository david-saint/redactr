declare module 'heic-decode' {
  export interface HeicDecodeResult {
    width: number;
    height: number;
    /** RGBA pixel data, width * height * 4 bytes. */
    data: ArrayBuffer;
  }

  export interface HeicImage {
    width: number;
    height: number;
    decode(): Promise<HeicDecodeResult>;
  }

  function decode(options: { buffer: Uint8Array }): Promise<HeicDecodeResult>;

  namespace decode {
    function all(options: { buffer: Uint8Array }): Promise<HeicImage[]>;
  }

  export default decode;
}
