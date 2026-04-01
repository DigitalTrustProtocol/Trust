export function statusLine(text: string): void {
    process.stdout.write(`\r${text}                                                    \r`);
}

export function* chunksOf<T>(arr: T[], size: number): Generator<T[], void, unknown> {
    for (let i = 0; i < arr.length; i += size) {
        yield arr.slice(i, i + size);
    }
}
