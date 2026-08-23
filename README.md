# Jerry 的赛博博客 🚀

> 记录赛博修仙日常 · [jerry-hang.blog](https://jerry-hang.blog)

一个 **iOS × Windows 11 混合风格**的桌面系统式静态博客：

- 🖥️ 完整桌面体验：iOS 锁屏 → Win11 开机画面 → 桌面
- 🍎 macOS 风格菜单栏（实时时钟 / 电量 / 网络 / 全局搜索）
- 🪟 Win11 风格任务栏（开始菜单 / 窗口管理 / 托盘）
- 🧊 全局毛玻璃 + 6 套渐变壁纸 + 亮/暗主题
- 📚 文章系统：列表 / 阅读窗口 / 搜索 / 分类筛选 / 标签 / 上下篇
- 📱 移动端自适应（手机上也是完整桌面！）
- 🦀 Rust 命令行工具 `blog_ctl` 管理一切

**纯静态、零外部依赖**：没有 CDN、没有框架、没有 node_modules，单个 `index.html` + `app.js` + `posts.json` 就能跑。

## 目录结构

```
blog_ctl/
├── index.html          # 站点外壳（桌面系统 UI）
├── app.js              # 全部前端逻辑（原生 JS）
├── posts.json          # 文章数据（由 blog_ctl build 生成）
├── CNAME               # 自定义域名
├── .nojekyll           # 禁用 GitHub Pages 构建，纯静态托管
├── _posts/             # Markdown 文章源（带 front matter）
└── src/main.rs         # blog_ctl 源码（纯标准库）
```

## 使用方法

### 写文章

```bash
blog_ctl new "我的新文章"       # 自动生成 _posts/2026-08-23-我的新文章.md
```

然后编辑生成的 Markdown 文件。支持的 front matter 字段：

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| title | 文章标题 | 我的新文章 |
| date | 发布日期 | 2026-08-23 |
| categories | 分类列表 | [blog, 随笔] |
| tags | 标签列表 | [博客, 生活] |
| desc | 摘要（可留空，自动取首行） | 一句话介绍 |

### 发布

```bash
blog_ctl build                 # 只重新生成 posts.json
blog_ctl push "发布新文章"      # 先 build，再 add + commit + push 一气呵成
```

## 前端功能清单

- 🔍 搜索：菜单栏搜索框 / 开始菜单搜索 / 文章窗口内实时过滤
- 🏷️ 分类筛选 chips：文章窗口顶部
- 🪟 窗口：拖拽 / 最大化 / 最小化 / 关闭 / 任务栏切换
- 🎨 设置：6 套壁纸、亮/暗主题、开机动画开关、锁屏开关
- 📊 关于窗口：文章数 / 分类数 / 标签数 / 最近更新
- ⏰ 实时时钟（菜单栏 + 任务栏 + 锁屏）

## 本地预览

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 技术细节

- Markdown 渲染：前端内置轻量渲染器（标题/列表/表格/代码块/引用/行内格式）
- 主题与壁纸：localStorage 持久化
- 一键刷新：桌面右键 → 刷新数据（重新拉取 posts.json）

## 📱 手机管理台（blog_hub）

不用登 GitHub、不用找 AI，直接在 Termux 里一键管理博客：

### 启动

```bash
cd ~/DSH_work/blog_ctl
./target/release/blog_hub
```

或者：**Termux 侧滑抽屉 → 长按 → 添加快捷方式 → 「博客管理」**，点一下就进控制台。

### 菜单

| 选项 | 功能 |
| --- | --- |
| 1 写新文章 | 引导式输入标题/分类/标签/是否精选 + 多行正文（单行 . 结束） |
| 2 编辑文章 | 选中文章 → 用 $EDITOR/vim/nano 编辑 |
| 3 删除文章 | 双重确认后删除 |
| 4 文章列表 | 按文件名列出 |
| 5 一键发布 | 自动 build + git add/commit/push（SSH 密钥，无需登录！） |
| 6 站点状态 | 最近提交 / 未提交改动 / 线上地址 |

### 脚本模式（自动化）

```bash
blog_hub --list
blog_hub --status
blog_hub --new "文章标题"
blog_hub --publish "提交信息"
```

发布后 1-2 分钟，https://jerry-hang.blog 自动更新。
