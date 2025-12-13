const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const config = {
  friendChecker: {
    ignore: ["hexo.io"],
    export: true,
    exportPath: "../public/friend.json",
    linkPage: "https://blog.yik.at/page/link",
    backLink: ["yik.at"],
    oldLink: ["yep.vin", "daiyu.fun", "yeppioo.vip"],
    page: [
      "links",
      "link",
      "links.html",
      "friendlychain",
      "youlian",
      "site/link/",
      "social/link/",
      "friends",
      "pages/links",
      "pages/link",
      "friendLlinks",
      "friend-links",
      "2bfriends",
    ].reverse(),
  },
};

// 检查页面内容是否包含反链
function checkBackLink(html, backLinks, oldLinks) {
  let isBack = false;
  let isOld = false;
  let detectedOld = null;
  // 检查新反链
  for (const back of backLinks) {
    if (html.includes(back)) {
      isBack = true;
      break;
    }
  }
  // 检查旧反链
  if (!isBack) {
    for (const old of oldLinks) {
      if (html.includes(old)) {
        isOld = true;
        detectedOld = old;
        break;
      }
    }
  }
  return { isBack, isOld, detectedOld };
}

// 动态适配终端宽度的进度条输出
function printProgress(current, total, url, finishedLinks, linkTotal) {
  const percent = total === 0 ? 0 : Math.floor((current / total) * 100);
  const info = `${current}/${total}(${percent}%) [${finishedLinks}/${linkTotal}]`;
  const cyan = "\x1b[36m";
  const reset = "\x1b[0m";
  const terminalWidth = process.stdout.columns || 80;
  const barMax = Math.max(10, terminalWidth - info.length - url.length - 5);
  const filledLength = Math.floor((barMax * percent) / 100);
  let bar = "";
  if (filledLength >= barMax) {
    bar = `\x1b[32m${"=".repeat(barMax)}\x1b[0m`;
  } else {
    bar = `\x1b[32m${"=".repeat(filledLength)}>${" ".repeat(
      barMax - filledLength - 1
    )}\x1b[0m`;
  }
  if (
    process.stdout.isTTY &&
    typeof process.stdout.clearLine === "function" &&
    typeof process.stdout.cursorTo === "function"
  ) {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(`[${bar}] ${cyan}${url}${reset} ${info}`);
    if (current === total) process.stdout.write("\n");
  } else {
    // 非TTY环境，直接输出一行文本
    console.log(`[${bar}] ${url} ${info}`);
  }
}

// 并发处理友链检测，每拼接一个页面都实时刷新进度条
async function checkLink(link, config, progress, finishedLinks, linkTotal) {
  let checkedUrl = "";
  let hasSuccess = false; // 是否有页面访问成功
  const pageCount = config.friendChecker.page.length;
  let i = 0;
  const errorCodes = new Set();
  for (; i < pageCount; i++) {
    let page = config.friendChecker.page[i];
    let pageUrl = link.url;
    if (!pageUrl.endsWith("/")) pageUrl += "/";
    pageUrl += page;
    checkedUrl = pageUrl;
    progress(pageUrl, finishedLinks, linkTotal);
    try {
      const res = await axios.get(pageUrl, {
        timeout: 12000,
        validateStatus: null,
      });
      if (res.status >= 200 && res.status < 400) {
        hasSuccess = true;
        const pageHtml = res.data;
        const {
          isBack,
          isOld: isOldLink,
          detectedOld,
        } = checkBackLink(
          pageHtml,
          config.friendChecker.backLink,
          config.friendChecker.oldLink
        );
        if (isBack) {
          // 检测到反链，补齐剩余进度
          for (let j = i + 1; j < pageCount; j++) {
            progress("", finishedLinks, linkTotal);
          }
          return {
            type: "success",
            link: { ...link, page: pageUrl },
            url: checkedUrl,
          };
        } else if (isOldLink) {
          for (let j = i + 1; j < pageCount; j++) {
            progress("", finishedLinks, linkTotal);
          }
          // 返回检测到的旧域名
          return {
            type: "old",
            link: { ...link, detectedOldDomain: detectedOld },
            url: checkedUrl,
          };
        }
      } else {
        errorCodes.add(res.status);
      }
    } catch (e) {
      // 网络错误等，继续尝试下一个页面
      if (e.response && e.response.status) {
        errorCodes.add(e.response.status);
      } else if (e.code) {
        errorCodes.add(e.code);
      } else {
        errorCodes.add("UNKNOWN");
      }
      continue;
    }
  }
  // 补齐未提前return时的进度（正常遍历完）
  for (let j = i; j < pageCount; j++) {
    progress("", finishedLinks, linkTotal);
  }
  // 如果所有页面都访问失败（无2xx/3xx），归为fail，否则notFound
  if (!hasSuccess) {
    return {
      type: "fail",
      link: { ...link, errorCodes: Array.from(errorCodes) },
      url: checkedUrl,
    };
  } else {
    return { type: "notFound", link, url: checkedUrl };
  }
}

function main() {
  (async () => {
    try {
      const response = await axios.get(config.friendChecker.linkPage);
      const html = response.data;
      const $ = cheerio.load(html);
      // 解析分组和每组下的友链
      const links = [];
      // 新的HTML结构解析
      $(".flink > h2").each((i, el) => {
        const groupName = $(el)
          .text()
          .replace(/\s+/g, "")
          .replace(/\(.*\)/, "")
          .trim();
        if (groupName === "我的信息") return;

        // 新的友链列表结构：.anzhiyu-flink-list
        let flinkList = $(el).next(".anzhiyu-flink-list");
        if (flinkList.length) {
          flinkList.find(".flink-list-item").each((j, item) => {
            const a = $(item).find("a.cf-friends-link");
            const name = a.find(".flink-item-name").text().trim();
            const url = a.attr("href") || a.attr("cf-href"); // 尝试获取 cf-href 属性
            const avatar =
              a.find("img").attr("src") || a.find("img").attr("cf-src"); // 尝试获取 cf-src 属性

            // 排除ignore中的域名
            let ignore = false;
            for (const ignoreDomain of config.friendChecker.ignore || []) {
              if (url && url.includes(ignoreDomain)) {
                ignore = true;
                break;
              }
            }
            if (!ignore) {
              links.push({ name, url, avatar });
            }
          });
        }
      });

      // 结果分类
      const result = {
        success: [], // 正确反链
        old: [], // 旧版反链
        fail: [], // 全部访问失败，含错误码
        notFound: [], // 有页面访问成功但没有反链
        updateTime: "", // 更新时间
      };

      // 统计总拼接页面数
      const total = links.length * config.friendChecker.page.length;
      let current = 0;
      let lastUrl = "";
      // 实时并发控制
      const concurrency = 100;
      let index = 0;
      const linkTotal = links.length;
      let finishedLinks = 0;

      // 动态任务池实现
      function next() {
        if (index >= links.length) return null;
        const link = links[index++];
        return { link, linkIndex: index, linkTotal };
      }
      async function runOne() {
        const nextLink = next();
        if (!nextLink) return;
        const { link, linkIndex, linkTotal } = nextLink;
        const r = await checkLink(
          link,
          config,
          (url, finished, totalLinks) => {
            current++;
            lastUrl = url;
            printProgress(current, total, lastUrl, finishedLinks, linkTotal);
          },
          finishedLinks,
          linkTotal
        );
        result[r.type].push(r.link);
        finishedLinks++;
        // 递归补充新任务
        await runOne();
      }
      printProgress(0, total, "", 0, linkTotal); // 一开始就输出进度条
      // 启动动态任务池
      const pool = [];
      for (let i = 0; i < concurrency; i++) {
        pool.push(runOne());
      }
      await Promise.all(pool);
      process.stdout.write("\n");
      // 检测完成后设置更新时间
      result.updateTime = new Date().toISOString();
      if (config.friendChecker.export && config.friendChecker.exportPath) {
        fs.writeFileSync(
          config.friendChecker.exportPath,
          JSON.stringify(result, null, 2),
          "utf-8"
        );
        console.log(`检测结果已导出到 ${config.friendChecker.exportPath}`);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      console.error("获取或解析页面失败:", error);
    }
  })();
}

main();
