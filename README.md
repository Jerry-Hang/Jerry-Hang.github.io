# 🍏 Jerry-Hang 的 iOS 风格博客模板

一个具有 **iOS 毛玻璃风格**、**暗夜模式**、**胶囊目录**、**搜索功能** 的 Jekyll 博客模板，托管在 GitHub Pages 上，**完全免费，无需服务器**。

> 📍 演示站点：[https://jerry-hang.github.io](https://jerry-hang.github.io)

---

## ✨ 特性一览

- 📱 **iOS 风格半透明毛玻璃界面**  
  左侧目录、右侧文章卡片全部采用毛玻璃效果，背景图片若隐若现。

- 🌓 **暗夜模式**  
  可手动切换或跟随系统，暗色主题下所有卡片变为深蓝灰色毛玻璃，文字清晰舒适。

- 💊 **左侧胶囊式文章目录**  
  每个文章标题都是一个半透明胶囊，显示字数、阅读时间、标签和简介。

- 🔍 **文章搜索**  
  输入标题或关键词，实时筛选文章胶囊。

- 📍 **阅读进度保存**  
  点击“继续阅读”可以自动跳转到上次阅读的位置。

- ✨ **鼠标悬浮晃动吸附效果**  
  所有可交互模块（标题、卡片、胶囊）在悬停时都会轻微上浮晃动，像被吸附住一样。

- 🖋️ **文字倾斜特效**  
  在文章中使用 `<span class="tilt-text">` 即可让文字在鼠标悬停时倾斜变色。

- 📱 **移动端完美适配**  
  小屏幕自动切换为上下布局，滑动顺滑。

- ⚡ **极简部署**  
  只需在 GitHub 网页上点几下，**不用安装任何软件**，三分钟拥有同款博客。

---

## 🚀 如何用这个模板搭建你的博客

### 🟢 方法一：纯网页操作（推荐新手，3分钟搞定）

1. **Fork 本仓库**  
   点击本页面右上角的 `Fork` 按钮，将仓库复制到你的 GitHub 账号下。

2. **重命名仓库**  
   进入你 Fork 后的仓库，点击 `Settings`（设置），将仓库名称改为：  
   **`你的用户名.github.io`**  
   > ⚠️ 注意：必须和自己的 GitHub 用户名完全一致，比如你的用户名是 `zhangsan`，就改成 `zhangsan.github.io`。

3. **修改个人信息**  
   在仓库文件列表中找到 `_config.yml` 文件，点击右上角的铅笔图标 ✏️ 编辑：
   - `title`：你的博客名
   - `author`：你的名字
   - `description`：一句话简介（会显示在个人卡片中）
   > 改完直接点击下方的绿色 `Commit changes` 按钮保存。

4. **替换头像和背景图**  
   进入仓库的 `assets/images/` 文件夹：
   - 上传你自己的头像，**文件名必须为 `avatar.jpg`**
   - 上传你自己的背景图，**文件名必须为 `bg.jpg`**
   > 点击 `Add file` → `Upload files`，拖拽图片上传，然后 `Commit changes`。

5. **启用 GitHub Pages**  
   进入仓库的 `Settings` → 左侧菜单 `Pages`。  
   在 `Source` 下拉框中选择 `Deploy from a branch`，分支选 `main`，文件夹选 `/ (root)`，然后点击 `Save`。

6. **等待上线**  
   等待 1-2 分钟，访问 `https://你的用户名.github.io`，你的博客就出现了！

> 🎉 恭喜，你已经完成了所有部署。以后只需要写文章就行了。

---

### 🟡 方法二：使用 GitHub Desktop（适合需要本地编辑的进阶用户）

1. 下载并登录 [GitHub Desktop](https://desktop.github.com/)。
2. 点击 `Clone a repository`，输入你 Fork 后的仓库地址，克隆到本地。
3. 在本地用文本编辑器修改 `_config.yml`，替换 `assets/images/` 下的头像和背景图。
4. 在 GitHub Desktop 中 `Commit` 修改，然后 `Push` 到 GitHub。
5. 按方法一的第 5 步启用 GitHub Pages。

---

## 📝 如何写文章

### 1. 创建文章文件
进入仓库的 `_posts` 文件夹，点击 `Add file` → `Create new file`。

**文件命名规则**：`年-月-日-标题.md`  
例如：`2026-05-20-我的第一篇文章.md`

### 2. 文章内容格式
文件顶部必须包含以下信息，**注意开头和结尾的 `---` 不要漏掉**：

```yaml
---
layout: post
title: "文章标题"
date: 2026-05-20 10:00:00 +0800
tags: [标签1, 标签2]   # 可选，不写就不显示标签
---
这里是文章正文，支持 **Markdown** 格式。

插入图片：`![描述](/assets/images/你的图片.jpg)`

想要文字倾斜特效？这样写：
<span class="tilt-text">这段文字鼠标放上去会倾斜变红</span>

如果想在首页显示文章摘要，文章第一段会自动作为胶囊里的简介。

### 3. 发布文章
写好之后，点击 `Commit new file`，稍等一分钟，博客上就会自动出现新文章。

---

##  自定义你的博客

### 更换主题色 / 暗夜配色
编辑 `assets/css/ios-style.css` 文件：

- 开头 `:root` 里的变量控制亮色主题的颜色。
- `body.dark` 里的变量控制暗夜主题的颜色。
- 修改 `--ios-accent` 可以改变链接和强调色。

### 调整毛玻璃透明度 / 圆角
在 `ios-style.css` 里搜索：

- `backdrop-filter: blur(30px);` → 数字越大越模糊。
- `border-radius` → 圆角大小。

### 更换字体
在 `ios-style.css` 的 `body` 里修改 `font-family`。

---

##   项目结构（简要）
├── _config.yml # 站点配置（标题、作者等）
├── _layouts/
│ └── default.html # 主布局模板
├── _posts/ # 你的文章都放在这里
├── assets/
│ ├── css/
│ │ └── ios-style.css # 所有样式
│ ├── images/ # 头像、背景图、文章配图
│ └── js/ # 交互脚本（搜索、主题、字数统计等）
├── index.html # 首页
└── about.md # 个人介绍页（点击头像卡片跳转）


---

##  常见问题

**问：为什么博客访问是 404？**  
答：检查仓库名是否已改为 `你的用户名.github.io`，并且在 `Settings → Pages` 里 Source 已选为 `main` 分支。

**问：修改了样式/文章，但没有生效？**  
答：GitHub Pages 构建需要 1-2 分钟，请稍等一会，并用浏览器的无痕模式打开（避免缓存）。

**问：暗夜模式怎么默认打开？**  
答：编辑 `assets/js/theme.js`，在脚本开头找到 `if (saved === 'dark')`，将里面的逻辑调整即可。或者直接让所有人默认暗夜。

**问：如何绑定自己的域名？**  
答：在 `Settings → Pages` 的 Custom domain 里填入你的域名，并根据提示设置 DNS 即可。

---

##  许可证

本项目采用 MIT 许可证，你可以自由使用、修改和分发。

---

**如果这个模板对你有帮助，欢迎给个 ⭐ Star！**  
有问题可以在 [Issues](https://github.com/Jerry-Hang/Jerry-Hang.github.io/issues) 提出。