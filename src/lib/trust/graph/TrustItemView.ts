import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { SharedListItemView } from '../../Shared/SharedList.js';
import { getActivateFromTags, getExpireFromTags, getValueFromTags, ITrustEvent } from '../../nostr/nip32010.js';

export class TrustItemView extends SharedListItemView {
    constructor() {
        super(TrustItemView.SIZE);
    }

    update(trust: ITrustEvent, authorIndex: number): void {
        const t = trust as ITrustEvent & {
            createdAt?: number;
            activate?: number;
            expire?: number;
            value?: number;
            index?: number;
            addressableId?: string;
        };
        this.createdAt = trust.created_at ?? t.createdAt ?? 0;
        this.activate = getActivateFromTags(trust) ?? t.activate ?? 0;
        this.expire = getExpireFromTags(trust) ?? t.expire ?? 0;
        const hasVTag = trust.tags?.some((tag) => tag[0] === 'v') === true;
        this.value = hasVTag ? getValueFromTags(trust) : (typeof t.value === 'number' ? t.value : getValueFromTags(trust));
        if (typeof t.d_tag === 'string' && t.d_tag.length > 0) {
            this.d_tag = t.d_tag;
        }
        this.authorIndex = authorIndex;
    }

    set d_tag(value: string) {
        const bytes = hexToBytes(value);
        this.bytes.set(bytes, 0);
    }

    get d_tag(): string {
        const bytes = this.bytes.subarray(0, 32);
        return bytesToHex(bytes);
    }

    set authorIndex(value: number) {
        this.dv.setUint32(this.off + 32, value >>> 0, true);
    }

    get authorIndex(): number {
        return this.dv!.getUint32(this.off + 32, true);
    }

    set activate(value: number) {
        this.dv!.setUint32(this.off + 36, value, true);
    }

    get activate(): number {
        return this.dv!.getUint32(this.off + 36, true);
    }

    set expire(value: number) {
        this.dv!.setUint32(this.off + 40, value, true);
    }

    get expire(): number {
        return this.dv!.getUint32(this.off + 40, true);
    }

    set createdAt(value: number) {
        this.dv!.setUint32(this.off + 44, value, true);
    }

    get createdAt(): number {
        return this.dv!.getUint32(this.off + 44, true);
    }

    set value(value: number) {
        this.dv!.setInt8(this.off + 48, value);
    }

    get value(): number {
        return this.dv!.getInt8(this.off + 48);
    }

    get bytes(): Uint8Array<ArrayBufferLike> {
        return new Uint8Array(this.buffer, this.off, this.itemByteSize);
    }

    static SIZE = 49;
}
