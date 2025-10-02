export function formatHashFromApi(hash: string, alg: string): string {
    const prefix = alg + "=";
    if (hash.startsWith(prefix)) {
        return hash.slice(prefix.length);
    }
    return hash;
}
