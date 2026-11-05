# TLA 应用内置字体准备包

用户已明确选择开源近似组合：Source Sans 3、Source Serif 4，中文使用思源黑体。此目录仅为Codex在D盘准备的原始资源，尚未写入E盘应用，不表示浏览器已实际使用这些字体。

| 文件 | 字节 | 用途 |
|---|---:|---|
| SourceSans3VF-Upright.ttf.woff2 | 170188 | 界面西文/数字，可变字重 |
| SourceSerif4Variable-Roman.ttf.woff2 | 429100 | 标题、TLA字标等西文衬线，不强制全界面衬线 |
| SourceHanSansCN-VF.ttf.woff2 | 7711988 | 思源黑体官方简体中文子集，可变字重 |

三份字体共8311276字节（约8.31 MB），没有自行裁剪、转换或改名内部字体信息。完整来源、固定提交、字节、Git blob SHA1和SHA256见font-manifest.json；每份均通过GitHub contents API的原始大小与blob身份比对，随后逐份回读SHA256一致。WOFF2魔数和头部声明长度已检查；未安装字体解析依赖，也未声称已经浏览器解码/排版通过。

随包三份LICENSE为各自官方来源的原文，OFL 1.1允许按条件随软件内置，整合时保留版权与许可。这些字体不是Anthropic Sans/Serif/Mono，不宣称视觉完全相同或获得Anthropic品牌授权。

DSH应先回读manifest核对，再将字体拷入desktop/src/assets/fonts/，许可证和manifest放入desktop/public/licenses/fonts/或等价可随renderer-dist交付的位置。用本地@font-face加载，禁止CDN、系统字体安装、修改全局注册表或从Claude/DSH提取私有字体。不得为此安装字体框架、字体解析包或改npm锁文件。生产构建后确认字体与许可证真实存在，字体字节与本清单一致，file://资源路径可解析。

仅UI字体资源已批准；若需要另外依赖、字体下载域名或商业字体采购，不包含在本包批准里。网络原始字体资源已全部备齐，后续正常无需再次下载。
