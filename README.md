# Jerry-Hang.github.io
# Jerry-Hang 的个人博客模板

一个具有 iOS 毛玻璃风格、暗夜模式、胶囊目录、搜索功能的 Jekyll 博客模板，托管在 GitHub Pages 上。

##  特性
-  iOS 风格半透明毛玻璃界面
-  暗夜模式（可切换，默认跟随系统）
-  左侧胶囊式文章目录（带字数、阅读时间）
-  文章搜索
-  阅读进度保存与继续阅读
-  鼠标悬浮晃动吸附效果
-  文字倾斜特效
-  移动端适配

##  如何使用这个模板

### 方法一：纯网页操作（最简单，推荐新手）

1. **Fork 本仓库**  
   点击右上角 `Fork` 按钮，将仓库复制到你的 GitHub 账号下。

2. **重命名仓库**  
   进入 Fork 后的仓库 → `Settings` → 将仓库名改为 `你的用户名.github.io`。

3. **修改个人信息**  
   在仓库中打开 `_config.yml` 文件，点击铅笔图标编辑：
   - `title`: 你的博客名
   - `author`: 你的名字
   - `description`: 你的简介

4. **替换头像和背景**  
   进入 `assets/images/` 文件夹：
   - 上传你的头像，命名为 `avatar.jpg`
   - 上传你的背景图，命名为 `bg.jpg`
   （可直接拖拽文件到网页上传）

5. **启用 GitHub Pages**  
   `Settings` → `Pages` → Source 选择 `main` 分支 → `Save`。

6. **访问你的博客**  
   稍等一分钟，访问 `https://你的用户名.github.io` 即可看到博客。

### 方法二：使用 GitHub Desktop（适合经常写文章的人）
...

## 📝 写文章
在 `_posts` 文件夹下新建文件，命名格式：`年-月-日-标题.md`

文章头部模板：
\`\`\`yaml
---
layout: post
title: "文章标题"
date: 2026-05-20 10:00:00 +0800
tags: [标签1, 标签2]
---
\`\`\`
正文使用 Markdown 格式。
\`\`\`