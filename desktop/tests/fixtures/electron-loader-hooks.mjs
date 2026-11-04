// 把 `electron` 解析到测试替身，让主进程能在纯 Node 里被驱动一遍。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      url: new URL('./electron-stub.mjs', import.meta.url).href,
      shortCircuit: true,
    }
  }
  return nextResolve(specifier, context)
}
