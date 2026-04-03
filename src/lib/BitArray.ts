export class FixedSizeBitArray {
    private words: Uint32Array;

    constructor(size: number) {
      // Each element in Uint32Array holds 32 bits
      this.words = new Uint32Array(Math.ceil(size / 32));
    }
  
    public set(i: number) {
      this.words[i >>> 5] |= 1 << i;
    }
  
    public clear(i: number) {
      this.words[i >>> 5] &= ~(1 << i);

    }
  
    public get(i: number) {
      return (this.words[i >>> 5] & (1 << i)) !== 0;
    }
  }