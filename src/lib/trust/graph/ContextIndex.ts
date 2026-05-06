import { SubjectType } from "../../nostr/nip32010.js";

const UINT32_MAX = 0xffffffff;

export class TrustContext {


    public index: Map<string, number>;
    public list: Array<string | null>;
    public type: Array<SubjectType>;

    constructor() {
        this.index = new Map<string, number>();
        this.list = [];
        this.type = [];
    }

    private _getKey(context: string, subjectType: SubjectType): string {
        return subjectType + (context.length > 0 ? ':' : '') + context;
    }

    getContextIndex(context: string, subjectType: SubjectType): number | undefined {
        const key = subjectType + (context.length > 0 ? ':' : '') + context;
        return this.index.get(key);
    }


    ensure(context: string, subjectType: SubjectType): number {
        const key = this._getKey(context, subjectType);

        return this.getItemIndex(key) ?? this.add(context, subjectType);
    }

    getItemIndex(key: string): number | undefined {
        return this.index.get(key);
    }

    add(context: string, subjectType: SubjectType): number {
        const key = this._getKey(context, subjectType);
        let index = this.list.push(key) - 1;
        this.index.set(key, index);
        this.type.push(subjectType);
        return index;
    }

    remove(key: string): number {
        const index = this.index.get(key);
        if (index === undefined) return 0;
        const contextItem = this.list[index];
        if (!contextItem) return 0;
        this.list[index] = null;
        this.index.delete(key);
        return index;
    }

    getIndexes(context: string | undefined, subjectType: SubjectType | undefined): Array<number> {
        const result: Array<number> = [];

        if (context === '*') {
            const index = this.index.get('*') ?? UINT32_MAX;
            return [index];
        }

        const subjectTypes = subjectType ? [subjectType] : ['p', 'i'];
        const contextsSegments = context?.split(':') ?? [];

        for (const subjectType of subjectTypes) {
            const contexts = [subjectType, ...contextsSegments];
            let key = '';
            for (const segment of contexts) {
                key += key.length > 0 ? ':' + segment : segment;
                const index = this.index.get(key);
                if (index !== undefined) result.push(index);
            }
        }
        return result.reverse();
    }
}