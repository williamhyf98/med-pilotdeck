// Keep compound formats intact when adding a project-wide duplicate counter.
// Older uploads placed the counter between ".nii" and ".gz"; keep those
// numbers reserved so new uploads never claim the same visible counter.
export function claimUniqueProjectFileName(usedNames, originalName) {
    const desiredName = originalName.replace(/\.nii\((\d+)\)\.gz$/i, (_, number) => `(${number}).nii.gz`);
    const compound = /(\.nii\.gz|\.tar\.gz)$/i.exec(desiredName);
    const extIndex = compound ? desiredName.length - compound[0].length : desiredName.lastIndexOf('.');
    const stem = extIndex > 0 ? desiredName.slice(0, extIndex) : desiredName;
    const ext = extIndex > 0 ? desiredName.slice(extIndex) : '';
    const numbered = /^(.*)\((\d+)\)$/.exec(stem);
    const baseStem = numbered && Number.isSafeInteger(Number(numbered[2])) ? numbered[1] : stem;
    let candidate = desiredName;
    let counter = baseStem !== stem ? Number(numbered[2]) : 0;
    while (
        usedNames.has(candidate.toLowerCase())
        || (compound && counter > 0
            && usedNames.has(`${baseStem}${ext.slice(0, ext.lastIndexOf('.'))}(${counter})${ext.slice(ext.lastIndexOf('.'))}`.toLowerCase()))
    ) {
        counter += 1;
        candidate = `${baseStem}(${counter})${ext}`;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
}
