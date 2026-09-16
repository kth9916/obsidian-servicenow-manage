const {
  MarkdownRenderChild,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFile,
  normalizePath,
  requestUrl
} = require("obsidian");
const crypto = require("crypto");
const http = require("http");
const zlib = require("zlib");
const { shell } = require("electron");

function formatMarkdownListEntry(prefix, content) {
  const lines = String(content || "").trim().split(/\r?\n/);
  const startsWithBlockMarkdown = /^(?:[-*+]\s+|\d+[.)]\s+|>\s*|```|~~~)/.test(lines[0] || "");
  if (startsWithBlockMarkdown) {
    return [`${String(prefix || "").trimEnd()}`, ...lines.map((line) => `    ${line}`)].join("\n");
  }
  const first = lines.shift() || "";
  return [`${prefix}${first}`, ...lines.map((line) => `    ${line}`)].join("\n");
}

function stripWorkLogEntryPrefix(raw, dateTime) {
  const remainder = String(raw || "").replace(String(dateTime || ""), "");
  if (/^\s*:\s*/.test(remainder)) return remainder.replace(/^\s*:\s*/, "").trim();
  return remainder.replace(/^[\s*_`~:.,]+/, "").trim();
}

function mergeDeploymentFinishField(frontmatter) {
  if (!frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, "deployment_finish")) return false;
  const deploymentFinish = String(frontmatter.deployment_finish || "").trim();
  if (deploymentFinish) frontmatter["배포일"] = deploymentFinish;
  delete frontmatter.deployment_finish;
  return true;
}

function extractTicketWorkLogs(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (!heading || !normalizedHeadingText(heading[2]).includes("작업일지")) continue;
    start = index;
    level = heading[1].length;
    break;
  }
  if (start < 0) return [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (heading && heading[1].length <= level) {
      end = index;
      break;
    }
  }
  const entries = [];
  let current = null;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    const topLevel = line.match(/^[-*+]\s+(.+)$/);
    if (topLevel) {
      if (current) entries.push(current);
      current = { raw: topLevel[1].trim(), index: entries.length, startLine: index, endLine: index + 1 };
    } else if (current && line.trim()) {
      current.raw += `\n${line.replace(/^\s{1,4}/, "")}`;
      current.endLine = index + 1;
    } else if (current) {
      current.endLine = index + 1;
    }
  }
  if (current) entries.push(current);
  return entries.map((entry) => {
    const dateTime = entry.raw.match(/\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?/)?.[0] || "";
    const contentMarkdown = stripWorkLogEntryPrefix(entry.raw, dateTime);
    return { ...entry, dateTime, contentMarkdown };
  });
}

function richInlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
  if (!(node instanceof HTMLElement)) return "";
  const inner = [...node.childNodes].map(richInlineMarkdown).join("");
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "A") return `[${inner || node.textContent || node.getAttribute("href")}](${node.getAttribute("href") || ""})`;
  if (node.tagName === "STRONG" || node.tagName === "B") return `**${inner}**`;
  if (node.tagName === "EM" || node.tagName === "I") return `*${inner}*`;
  if (node.tagName === "S" || node.tagName === "DEL") return `~~${inner}~~`;
  if (node.tagName === "CODE" && node.parentElement?.tagName !== "PRE") return `\`${inner}\``;
  return inner;
}

function richBlockMarkdown(node, depth = 0) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.tagName === "PRE") return `\n\n\`\`\`\n${node.textContent || ""}\n\`\`\`\n\n`;
  if (node.tagName === "UL" || node.tagName === "OL") {
    return [...node.children].filter((child) => child.tagName === "LI").map((item, index) => {
      const nested = [...item.children].filter((child) => child.tagName === "UL" || child.tagName === "OL");
      const inline = [...item.childNodes].filter((child) => !(child instanceof HTMLElement && (child.tagName === "UL" || child.tagName === "OL")))
        .map(richInlineMarkdown).join("").trim();
      const checkbox = item.querySelector(":scope > input[type='checkbox']");
      const marker = checkbox ? `- [${checkbox.checked ? "x" : " "}]` : node.tagName === "OL" ? `${index + 1}.` : "-";
      const continuation = nested.map((child) => richBlockMarkdown(child, depth + 1).trimEnd().split("\n").map((line) => `    ${line}`).join("\n")).join("\n");
      return `${marker} ${inline}${continuation ? `\n${continuation}` : ""}`;
    }).join("\n") + "\n";
  }
  if (/^H[1-6]$/.test(node.tagName)) return `${"#".repeat(Number(node.tagName[1]))} ${richInlineMarkdown(node)}\n\n`;
  if (node.tagName === "P" || node.tagName === "DIV") return `${[...node.childNodes].map(richBlockMarkdown).join("")}\n\n`;
  return [...node.childNodes].map((child) => richBlockMarkdown(child, depth)).join("");
}

function markdownFromRichEditor(editor) {
  return [...editor.childNodes].map(richBlockMarkdown).join("").replace(/\n{3,}/g, "\n\n").trim();
}

function createRichMarkdownEditor(app, component, parent, initialValue = "", sourcePath = "", placeholder = "") {
  const editor = parent.createDiv({ cls: "clt-rich-markdown-editor markdown-rendered" });
  editor.contentEditable = "true";
  editor.setAttr("role", "textbox");
  editor.setAttr("aria-multiline", "true");
  editor.setAttr("data-placeholder", placeholder);
  Object.defineProperty(editor, "value", {
    get: () => markdownFromRichEditor(editor),
    set: (value) => {
      editor.empty();
      const markdown = String(value || "");
      if (markdown) void MarkdownRenderer.render(app, markdown, editor, sourcePath, component);
    }
  });
  editor.value = initialValue;
  editor.addEventListener("keydown", (event) => {
    if (event.key !== " ") return;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const block = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
    const line = block?.closest?.("p, div, li") || editor;
    const value = String(line.textContent || "").trim();
    if (value === "```") {
      event.preventDefault();
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.appendChild(document.createElement("br"));
      pre.appendChild(code);
      line.replaceWith(pre);
      const codeRange = document.createRange();
      codeRange.selectNodeContents(code);
      codeRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(codeRange);
      return;
    }
    if (value !== "-" && value !== "*" && value !== "1.") return;
    event.preventDefault();
    line.textContent = "";
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand(value === "1." ? "insertOrderedList" : "insertUnorderedList", false);
  });
  const replaceTypedSuffix = (pattern, createNode) => {
    const selection = window.getSelection();
    const textNode = selection?.anchorNode;
    if (!(textNode instanceof Text) || !editor.contains(textNode)) return;
    const beforeCaret = textNode.data.slice(0, selection.anchorOffset);
    const match = beforeCaret.match(pattern);
    if (!match) return;
    const range = document.createRange();
    range.setStart(textNode, selection.anchorOffset - match[0].length);
    range.setEnd(textNode, selection.anchorOffset);
    range.deleteContents();
    const node = createNode(match);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  editor.addEventListener("keyup", (event) => {
    if (event.key === "`") {
      replaceTypedSuffix(/`([^`\n]+)`$/, (match) => {
        const code = document.createElement("code");
        code.textContent = match[1];
        return code;
      });
    } else if (event.key === ")") {
      replaceTypedSuffix(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/, (match) => {
        const link = document.createElement("a");
        link.textContent = match[1];
        link.href = match[2];
        return link;
      });
    }
  });
  editor.addEventListener("paste", (event) => {
    const value = event.clipboardData?.getData("text/plain")?.trim() || "";
    if (!/^https?:\/\/\S+$/.test(value)) return;
    event.preventDefault();
    document.execCommand("insertHTML", false, `<a href="${value.replace(/"/g, "&quot;")}">${value}</a>`);
  });
  editor.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    const href = String(link.href || link.getAttribute("href") || "").trim();
    if (/^https?:\/\//i.test(href)) void shell.openExternal(href);
  });
  return editor;
}

// BEGIN GENERATED DASHBOARD ASSET
const EMBEDDED_DASHBOARD_GZIP_BASE64 = "H4sIAAAAAAACCuy9a3Mb15Uo+p2/YgujOIAEgABfokBTvLIkxzqxLI8kO+dcihab6E2yI6Ab6W6I4lA4Jdu0r2IpZWdsxXJCOUqNZhxP6dRlbCWWa5R7qs5P8UcBrJOfcGu/uvezHyAoJ3Oiyowl9H6stfbaa6+9Xnt5edm2QuuaAzd+GoyNH9nvnzFwBFyE/jWnCV/zNsDg0/f6jx6DvXvbe599OQbw52dPdvsf/Cv6WwUMHmwPvnoMnn11c/Duz8lPr3mh47lg797dvXd3Bvfvgf6Hnw0evA327m7vbe+SNv3bDwcPfwkGD+72HzwiP+39cmdwewe16n+8AwbbD/bevQ/6ux+CwYObg8/ZdP/xqP/bp6C/fav/7Tbof7zT//zes2+egMHvdgcPbinN9371c9B//58H9x+bWjx7fLP/4Pfje+/dGXzwcO+DJ6D/6Mlgewf033nc/9NN0P/i7b23H4HB3e3B/ceDP9/b++wTCsgfd55983Scoj/4/JeDT98Dg/tPB1/cRFPt/foObSd+uf3g2Tc7YPCnT57t3iQNLnmV0x6Y7N/+/bOvt8Hg2yf93Xug//VjRAQE7N7t3cHTj/tfb4Nn3zzp/8u3Y2DfSzw+NjY2Pg7m9/kHjVGvgsHjW8+e7CLCjGLMsabnBiFoem5oOS70wTywr1Wjf87hBuTvVcd1of/KpXOvgnlQKMxxX5otKwhedYKwatl2seB1ukHFtoL1Fc/y7UJpbnQEmKiCwfbDwYO7o8T+4plLl86+9qOLV3585r+BebA4BgAAMhZl/KvV6VSvWd1WWF2D4WtWGxZL5AOiWtf3oRsWSwvVVacFF6odK1wHCwugYMNV1KcwtlT9qee4xUIDE0Wa/eKpV86cO3nlzTMXLp49/xqYB/VjUaPTZ14++carl65cOP+TK6+cOfujVy6BeTBxPPp+4fz5S1dePv/q6TMX0OpcuXLxzIU3z54689r5n1zhvl25UpjDa7H3yZ3+bx89++bJ4P4TtF3Rvvy3R3t37/U/+IQKISKDwOD2Q7StB/feHnz6P7B4+WobbcPP3+vfvtW//bDKIDx58ZWXzp+8cPrKhTdeu3T23BkOkcJEtV6v1goKOqfOv/rGudeu/OTs6UuvXATzYAvTElGvAaYnCGUduwHqEzXyjyC0wm7QABO1afJD0wrhmudvNsD0LPml4zue74SbDTBLR+h0/Y4XQH6Ydc8PT8Og6TsdJD0bYCL6FAnj16OB6nX6MXSaV2F4yodW6PkNUJ8Wfr8Af9aFQQj5L/FwuBdEyExR2K0gcNbcNnTDH/let8PBR75A+3XoBwg63XAR4hMzysc3OrY0FwxCp41++0frlNfutCBC+7QVIqqw/qHlr8EwoYHVDLtW6wJsQSuA9BubwOd/PU4pHzTXod1tQVv8uWUF4al12LyKQIx/DGEQ/sTzr77qrXFYhZ7tXey22xbCtT41IeMaj/BTx7divtnw/KuOu/aaF8KgAY7RX1eCBpiaIX9f5f5uc3/vhvEoPkRw2ae9ZhctVMxUCFj112a0yJOULt1oKSanx3ojFIWTVfDs6z/uvf9HMNh5sHf7Cdq/t3dHIxdXu24TaxVOcKbdCTeL16xWF5bo/vRh2PVdUMT/QH/wVzA/D9xuqxX9euNG9AEdGPzvcVf056TvW5tVJ8D/pVMJDV54gYxUbUF3LVzHA9aiFqRtaW6sxwEOg6bVga+E7ZYW9ouh77hr5BMW0YV4xqoPOy2rCU+2WsXCC4UyKLxgtTtzphYv4hat0NjgBG6wZmzww8IPUYOfdT3zGD/EY/xDbfL4XEGL6ckw9J2Vbgi16CrUEIdYg+HLTgvi8wwdWnpiRccZD2TQaTlhsTDO/9bxOkUVj+L45WrbPjzulNEIIgBOcOZ6CH3Xar3ht1KYLdzsQG+VZ60Awxcz2AsvgPG3iuth2AkWGpfHL4/faFtOK/QaN7yVwLEdy8W/lsadKtrFIjMSRgt9p83hoGUx1/PbVsv5JyzzRKCdVVAUtw77wqGEdCj0z95Y1IfHbaEaei+jKUKCJZu3oBmKAk3bFwubm5ublXPnKjbWvqRJpG3ruEFouU00L0KEp+Kh17rtFaT5Ba9ZrxFEkN5zyUF6D6WJGZizF89TzilVg5bThMVaGdRrIkBEHwjh9RDMC7uyRNdgjmtm2+02Qg3M4x7VthU214vjbxUv21sTvVKF/+9UrzROOyOkWVcNvMuHt9jXxcmlXoX754T4z/pSb1kDPQYD2iJU0SzjGJgKBo38/3HGTTyD00EWqou1JbTL0FAJ/IbX4K+U58ArrzTa7e+B81YxKBJ5nhu7FRcal4Oj5McG+VRcaNC/LZQW0tiRwua04euWj+CL+G5qCSyAZcBx4tRSbxk0ouUclpsPb7HptIyNmrXbtq0jgMjSuZBnwyYizxotTjDkuV8SkI9aJaGn0QJMwv1N9HE0O02n55g2lnAmVdtWpyhCJCpI6MIZQr/4kue1oOVKH8mdEyRtSPVQ9VZ+CpuhcKiSbWjT7QUOzc+DrmvDVceFttoObzK1jQbhRc0BHM2CFY6y7ohG4+Ov0cel740oSDfKgx5qr0PKdoJOy9oUP/HqWdy9NGK0R3QOCNOph0KsUuXckEjJ65yz/Ku2t+EOrdMXxw9dXry8WFx86/LS0tHS0tL4WhkUDtd1TQVMxmm3G7jf5RvCCCLOhycKkuIoqcHDAhB1ulxcfKu0dPRySZ27njL3kctHiotvHUE4HLl8JGHy8StXiotvXVk6WrpyJanZcnHxreWlo6XlpEZvLV4OThw5Wlk6Ol4W14WduvxSS8c4EgVgHrhwA6sJxUhmkjOjY/lhQL+fdcNWlXWUGbJw1av8+AInS7YE2qGj4v/2XNgAhZOBY41fhF63JUmeTWj5DVBwu23oO03pY9tzw/UGKExUbGfNCaWvtrVp/LbudX3jx7bjdpHxJKFvfaIBVq1WEJ8aPSKMqoSUlzx0BgaYkkztJMTDmwVR7zyWbNVV32ufcUPfgUFMOExhfAZ18Nl8QhJp6NcqEh9l9WfxMFsq6VTfeKblw1sEoiqiNNJW6D8xbbl/29ZmDyxH/Y5yPRFBeo24JyZfb1l3gyPWmlOeG/pe66xd7Phw1bkesZf4tRog857bhGA+mrdobLOwAGolcBTURVRjwpG5Yoohrq263gYzKCdBgBswW3KFXqZHZVeaqjK3z+DB3cH9e6P1M7S6bTeIjOzxDrwK0fZAll+Ov1vWCmw1QOFl8We8sg3QsdYgYkb0X2xxLwsntzocORgvkW9IfeC+BZ4f8l/I4VTWQunYGhhPXQD9r27t3XuSAqhjK2A2/QMAkljKNYAO3n17792dFChJbwVSCR4B1gC2kG40HLTMjK+B99kfH/X/tJ0CL+v//CBmbgYdhYkT93W1hQ50NpACOrSd0FppQc04mdGIoExEhfhHNJi8rnzRYkBaPT/ay+4bDeQXUROgb6NleNT+ih23R2bq+MtpzYdh0N7PhlYcUzq041CCjOxHh73iehtXjKw47EpmYj/BqabB6RL+DtQGOnTIYFeapPHzY0nJA2hGQ9ckARGfNX+Ou0t2WSbz2eDd+4PtPwzuP83BaNRNpuDEbv0mvNB3PVZRzyTMJIerBq+TUQsgN9HhFA94ZQ01f36LJHqIjZhAGygtzIhA+0oHt/5emM2sAnDcpmmVymzD6AYjEdTUDZ+yf27dw4p2nv1DncrPe/8Ygwg0GJ5hbcE/ngRxayA112EaTXPlZ9aVZtT1CjYEsNPX0Ej9LsPKWiwmg7j0vImrj77QHSS4YX6ykgmSaKprIX00U9MM1nMnpRKnopOPuA2gjbLQj4x6hQa6iJRTZozpopvouVPET6RFf3d378NHqSJokWu4FKGupQc3nxbV4dBMFrt8rJHuVoZDQwf3bmWRtotK86XnhQcXHKVbqi9uDb642f/i53uf3R3cf5K6YFLz54gFF82lWw0c0EvjdUm4ropL8QrCogycELZLCCnRYktsSi1vDczjJgtVYdY5oTFycRxqeWsl2UHHN2h5a7Hn6YUX0NjYzxR1Wl48vMU36i0B8gNqxZyMkoOEfUabQ5jgxg0BiJ6yNiYijkpT4ULrdOcMCpUeclE60LUdN14YNFOwwFxT6F+oJ/ovNTURPxPtViixSK8bN0BtTjO+477ue2s+DIK8UzhupUO7Jk3D1nvwxTYOf32wDQ5vUfB6gP368Jfg8FYMC88A6mrqqT16rTNR3UwVe9s7/W+3Bx887L9zb/DrXY3AgDRSy4RDx4cBMlKbLALK15bjXr3khCjmV9CLP3387MluIs4o4FOD7X8Rf9ad5ajn88UMAZUFJz5sVSc3f3Nn751v++892fsgVfgLbdWFDNqWH77quFcPBF9+8ix4r+iwfeliyjq+dPH5ruJLF7PgsqrD5eU0XF5+zri8nAkXW4fL6TRcTj9nXE5nwqUbanB541IKLt1w1FtHEvM8Im9cYilRGfCRgtN1zhOcb0WHTJMXYmONqkjnOdsU7EmjQVyYPAvyfAC+BnM5xSwNeaX9c8ZfSYnLQIKm0T6b1Sj7PRliu0bDWFZr2IFbwMaWomylttXpQPsSbHfQdnvd9zrQDx3Igk4uwrBIc8aQZ5h3ZsZuWM7LRv1XvLMJf4/8NZEyJzhlKNQF0cOBWsuuAnmEiE14CzgxWLNBJfuvMgKPkWqHZKMkGe4woCYLFAZNNa+wcTn7hOker16MgaLLlpnGSBQLciSTw4ycDXp5qRElsh7GbcWYuceWSnOUg9Yd24ZuMgcVmuuWuwYpaa4zTsD8c4V8w8MHLevKihU4QSEen3AAGx+FS4B5MVfx5EoQ+lYTBxK+tPm6Fa4Xlw9vcamBvXHWPRgnSbBg770dlCf4b/+z2raXS3NjOEpQmWmhik52N0DmPnzDattRmGDob6oxvrTvRa/rNzGcG5YTctA2LWTJuQAtWzNbaU4abtX33LBthSFOXhUHjwKWK5XKZX/hsltcvBxcvrh0ZKGE/1mpVMZLC9XF+pJ8F6e3WLJQmyjyEgetVKtVbj4yPMrPGX8LxeYFjX9YWnyrsXSk1Bhfa5eW1Bhe3AHJMPyXxfoSjX9LjuaNwVr1fFAUYQPeqghnSbqQo1UzSbDquhUUWe8SIoKJU8WWJZwx7LhdqLucX4UoZH6ZrUXj8BbrKFtIaDxQtdMN1osi2PSwKCs/0pOCDak20B3vrPWS2lzvDMpyPU+8pkd2gJKIsjb1dfEq3FxCGb+TkhnCuHAo0Tpajjkp7q+H0mKb66AIfd/z5TB7rwWrG5bvFgvyPkfpvSRZHgze/wVWILbB4P6fUS59/9//Y+9XtwYf/JGm/RbKgIzO4nh7YpDXOatDpds5q1Mc41cb7QTydzGWkPxWFVad/DZGgwdHmUo+XQWDdx4Nfv3l4POPaFI5TYMecQ4lORpOkxzwizAMHXctKErBy/ESITt223oT+gFOTDakh5fHYvXICZyVFjxFqNsQyKzZbYjmMaXjaGFuRPL5vG+jVOb9D3fV9TbckYP3E8cO14OGJO2q1ap2h/F2uTiC3dt4BTpr62FDk2DPtQug5TfXfww3NzzfbuB8hOib1Qyda/BNB25gH94KjjiMtVLP9nAgwUubJP6jAUK/C6UWp0nU/znPRjKE1RsQmpyyWtC1LZ9OhONhTW1Ous11lJ5ekBtcTMADff/HrtO8SmewWi35M3KsvIQ0D6Qtd6Hu88u+19YMjEOyPc2HU16rZXUCaEfssbjEE37d2zjZ6bQcaL+MBXGg0I9rctHzQ7XBKusojkzaLpJDuifGBbc8y1Y2Ks0JI9sYaQOGfU0DfnWqj29tcMHD+DDzmlbrYuj56E6zBsOzIWwX+XoUbLjIheFbG/IJT0UIA40/DSQAAusazlP8LxfPv1btWH4Ai2g8bo4WDCWBIkEsJjHhAatih5JyQC4AXTum5ijN6dEfS4JzVgfrH1fhpjq4+ksjIoU0o0RLoSNJOKQICTIYxXLX1VleNIlmOXX9kIS24zZbXRsGRdHWy2Uba10q6Opy1rXhdWlB1COg6qBm51eL5LrDL6/amKq14o9Lcwk9cM63nJ7C6i8QCE/w+fkiJ8SNjoK6tk1Dno84aVS9q6b+JJJU+FzS7ovcfABeBFPZV3glfV0RxBjcvIsrcs/zWmQJ3ISVlloeyHKvHNgiT2df5MhCk7bUzIySd6Uj88tzW2UR0oRFFhseyBqLQcTpK51hcWf06+PCjR/DzTg9RQSDs99pQrGVOOakmOBoUE2srSZMNSHcUzeSaqzTxiJyKnNTPJF1mjhyovth8BMnXC8Woqt9oVSSrnNxD/HITOTDLJzL2T6QcuCtsuWS15Lxgao7JG5j1KAk8yk2TKAvIiy9mPcAbAVQHwPhw2uO1w1amz9GFyDO1qfTofhLUinSmPhfAVJXS3N6vm1tnrxmOS10/0CqqfamzS0NW2mqZh2SYI0oVsq9amXETyJA8mSJK7CUoL62ob8GbXLxi6qFcWwcqX38DbEst6IE59sgwbDVixm2NydPHV0VJbEtCJuoUWlOq3njGzWY1+rQ3J1b3DiMFbgGEkFVRhdHkKWvAhw3tCL7qtVqDLtCS8poqkzJJhR4ayfjjng2iTPGOFEiJ6GLrJDbhJLDSpFqqZCtFRoTTdrBT6OSThhPXbG94cg1XIIk0Li1135hZhZ+70kNYzOKAklUxuVlx3VCWIx3iAGzc1a4jnJ29bdC9GdGoyOwP6S3db04MVUGKXOV0sgW9ZfQFa1BWnuyt0o3rdBWX61Kt9eFbmlwCo0lWDnrlDLMIjNXkdA09N82hMiKUViKtx4BKB6nlAh43C4N6rilBLJqMksmsdKekHmFOE+S6az0TYNa6aABnrfmaYhOzXvITUzMdSq1pVFKqThwjbNgwDXXwC+YGjUIUNsjKGxAeBX917Y29TjwI6UjwbfOggXfPgENag1VRhx/S6lidHicFISjlURU0MhYxFlYyo4R6ZYHJ9JDg9XFHMJHaZ9dACldswB/MUEQieZlDVdhezOqugtJNASNBC6LEbtEVln4buNdgz42Q6PIHBfqWTCaM321oqZZcI0a6wRAZCfX4MkFClDgaSwEtA2CgI2WQQywppmEAGtswACb8tMZjDXNx1usV1ZAUVsDnJe8jFBe8vLDeMnLCuElTyeDZPeGMpruKqDrmUHYSD2YXk3LV50AiwmbSt5AtDhZJpElzStrS6oLJ0VlUjrkONDVzgYUTFPSYitZ5jTMy0Yw9uFVNwVcM/WIdysz7XDz4SiHu/6t0A0DK1Ft1cRout1GGydvMNoo0WUVzwzmTxhbxDcrdmEnfRboXfrHujuyZIqmi8A6oigQZHNMF2+pG3pVz4V61tNREzdNpiVukkpJv4ssWXnoiHrkoeJiwQqaWPjBoMkLPzKQ7fgQu4OHvD4Gwi7qzWWMzMEfpCp6i+zdC/51kCUWtNL/063+bx8N7j189mQXl+u/83vJyovH5CvvjSW6jnti4T3rGlSc4aJ3W/BiB9SLLUDAu7RF2LArmvCss7pZDOhMJaVQ4AFQjrxMkpFmKmXWYPimYFqRYgWo3YUz/DLsZI/5HB8KFDXiTDNjBmsZHUdj+MOWK8VAuAZDuZ0SbNgbG0NRAAwMMC/FQ4wwBmumKr/Ysv3t4L17YO/dj9D7NqONw1p1XJvmUl4kO7vYpvUkxXVrOS4O92RfaZHzcRwzOs62D6LROrSQQvWq40Lq0wOV+pzyGV6DLUCq48cfAwLDGdfmu+O5qQGQToQdH0KAhkMbc8GC5KcXpf7i16Pz1D2nFt6lkJ4j8aliiAoacRGPsCTXto7v0sV/2KqXZ3olVAS4erR0eFx21olRLPx8Gl+cFFqqOAKiWrj2K2QgCWZ++MWJJdXmrC2xGWGz+Nblztarvcudrdd6S+NrXb3BsVDIEItSDb1XvQ3on7ICWCwlBaAcUpCKTyTV3SckTo/pYchFWA0r4zWfU1oQbjbTu74k8i/6s+JD66pSclaZ80VUNFGpMBvvm17ajlBGxBUY/zY3iZHCcmSCnvpqwNK8sIRGNtELJokZpEXlYo/H9GGtmEJlI7uVtWzGJeqoQHGRe6M6j47J59HenTuD238Y8UEEr+NUDHoWBYZTiGLMMVrSATYX76pDtKeuFPWSpso7JPVekedvKT6e6GtWqBjsZnR2Je8+HRdVM+1IbU/NkufYrIjfwHw0GL9BFf/nSrfVgqFpX5v382LlyNGlbJuZm0KXoMFTWxfPQNeIxCMIjeXABFHii4uojutbGw0e/TglRT3zPBIPzkDRSJne3Fj2A0cRcTywsojD6yA/yiIfb1z/Kgq1PapGWC1fdg9vcYMJFRvk48m0KGmLIYpA1lrwJBfRr5tlwsbGKhosJVHHmQwQjKqJRYH2/RHyVsNle6tejh5rWBhXlRl1NTmYNOAI4EYPmaC0KnFPQfYCh5pJIxR5j9AraUZAvAXdkDVOoo7UG7+/QUHV7TX6Ogj6j5agkfLIBhFLmmfXM6kQaVwOqmVcGt3YqpDHnBPVVNfELaTRTNPKCFQ6cjxTlBNbFcymwtI+AcDF549cWf7vjWo5kcjDw8E/HWOQxNo4lWT6IAYsp61hWS/SI95XvzuR7iTZpmIZqD4P9ipfiai4QTUX/kGUaIhDolkwasu//8Z+VB90y6L+M2WmWq2ygZa4F8k8PywWW3A1LAMfh38YK0fBVfzKgGYfoE9KoSbNEHgCwxj4W/IguOYUgwK9lRKNpxNMrJ4U7VDFZjeIqu1ZvmETROPppHs6u2IyEFWrQvGR7gFc0FzVCouVOuEdK9h0myDiIB9adqTuooTMpAThVZy+LIaxpKQyK9hFNeHjl1mMtgjUzJBSs5gYjagXownpzKskgVlmcON9YB+Wz2WT5VM0t93/c2w0bqAKVwLdess57cjx/WKUl7JKvUrfbSbXMfxQc/SEMy5nzx6ZHr3F8BIObNiXufD5WwtFI6He7sFdodJMHTrzhsaawYkUjZFPvQwYbXmJ9rv4VRnFTKfoYbL1TQAvwd5GAuK0ae557WRG29gwpjHlRFRWW3vd/p4YQBjDaKeS7VKjNkfx2he1QqnWJ9HqpJ1TyhGlQhuJh1hilwF/uEl2HLM4mdPYbiSJSmtnoNk4Q02UVnrWjt8zRCAsVB2bhqlpHjZ0gh9BF/pWC6VngXlAepBHy12rTR87I/UfWUlX9fvg/tP+7j0QN6NwiH25H5M6kG8FAVkcYIkxEwFGd0rQAEXSHT0nPP5W8dSFGxcvlC7bRw+zZ10FcnDA0+g9sMATjBx66HsJPy1YKqmg4FJN6GbIADOMEFXBjdYADUmLLQw+fX9w/05BltYtjrcTTWdcyxcTTWVcQ/0Wp8VIJBNZ1Ivb55eDIyVm60LPkIHr/3WpdHnJKPjbyRI/CnjDhyYR8aKkJjxxXSnIgnYMtLnSn+MvHqpULgdHmq2wgjZHg4truhwcqVROMG4gE00uKQVk7C4p2MxgmYwQl8au2F3YKOqsKZf4Zy8XSmzipNIyEQ1Ohhlmjlo3iotvnVg6Ks+xQDe5PBfiLBuGloMCc4QvWPHmvtmw6dnwjQtn0XXCc6EbU8xIDtyZQHQkEaDSHJcxRZXZKyVh/tFNJszF5OMpcmvmJjLoFJeDIzJLFRcaNHDuBsddN1DIHAXkcnBkfA29aw1k/SNhXMxO6dy0nxlitsFcMzykhPiY9omDyIYQ2WTILQVb6IzWyRKxJ2r3EjXYicbDeCYDombrHf9uYWyc0yiXWmxDK7jKJDk+rxWNj/yqqXnk2A30kJ10CWs0Dm9Fg8pXMtQMXYEb0pW3LL1tSE4s3a/4VJM+sNnKijNE87PegkXFalkymkRST2pNBIEEBryO6qXQ0tnxgoqtTL+TymkN7rRZoHGuoCEfJAtiQCw6rlmsLGfpmFM1SryUJosH0Q2zmTtSTRzi8sonLrFhaKwWoomBQJRmoaBabD7rg8ngQC7u6YYGoZqUyaSgITJVDBFml6zgqhyDtUY+D1sSDwGPq9/x1su8o/B6Ly2lxxaOAy+pjp7KOzozVJLpiZuopK10brjPbGH+bPB0LGM5VSiUo+R/VCz+/OnzBaHYmZlxVOYpLBKuiaxUHMUk3imonKK56SGu0fHLqg8DVLEPoYmiFA3sgjkpIqiezcj8IRuIJkMjvg6qqy0rRGXPUGV6ZH1G/yUF6hH/LC6VcJY0P5kW3tDrNtfRlK/Gb0IUeXOluvcLBem+aCHHr/Sibqka4LIPtTKo1zhuRJyDRjtnudYaiizu+F4TBsHLqObhOVzzMJkjYwbkhtGMgpEoi7UbT2gs3lwDzVsW5IC1NueMBfd6vLbJswl7OngNnsVLxEKq8fJhS3wherY8PgIWAF1ex7XFteUvmUig4R0cS+uxOD44tt0gijMIFqrkmGD/rhqe7xBRjg8h9IvKP6QSKTY54MOwiA72MnDh9ZD8IBWhi9ufJucx7bAVHaZxV0xndUoborMWDYH7irsr41GHOlaZYsMbRwinh+u+t4FDas8Q4UHEBKnF2v/Xp2Cw+//hwoW37uHbdlyykLPFEjjRDRQ/nEw+yPKTMi7l1ljQnlAO8cxGHtXQY0CHRMJiPFLQEVXPV6k1mlcCFCthsoXByWJd0BsPGXrjb10OjsQmA2wxwAYDmmGpC8splWIEiHZMoiNkQc/ji+oJv0oifaK+i5h/Ih12SSJ8lJJ+1g3hGnoqJBqlpFmNwTv/Y/BgZ+/uA4D+b3D/KRjsbA++vYeKZPa/vvnsqz/3P7o3+JSrjAn4swytXP/2w8FtXNB78KvHYPAvTwfbTwa//kRYQIEgrCxPDFkZ1LnGMfOiWneKyiSORV6Jvuyy2Xr8jqIjJeKN+THLviLbx3xoJYsoUeSQgse4ykdPFCKcCJpnzdgLLwsLmA3oPzk88+S+ceKRHav8mcpKpUQwKDMKFh7Hc9GZG4RWmxREjaFHpwyenDtgqEGR4cWbiW7cIFNJvxUlgA5Fw4IF5eCntk05lKoh6Q1/JYL67/L47/JYXo0DlcJJhvEYLMkyXsR0LUmETbSMG7Hau3d3cPs+ApdofPj3dEZrotSdv9s4v0cbp+c7a45rtU7Htk5+UYa2duK9w8cQyRLdBMglnVGUB8lAGxmRUZtH0QFIYZPOOmzoW1gQMChxa4bCKY6Or5E1SRj9dOTQkSZgnh6mJXD/LiSPGLkp5BHph2jE+N/JI54S3D8aVUHZ4UiRWvGum1QIZMK8jg2XQLGPE90EMQGu7yX3FyyfC6AA0NYAOo8aqFROFDhlQXCiCeOzNVgAy+JwWCIc3uLa9NCoy9pRo70tjM3TTh0/lgdkFq51wkxk4UQU2FqqKBBRcXgLuorTjOtZ0s5nPFTQkwmHt9jDED3214mlHlg8vMXWHz84Ke/RHkAmVbazeoe3+BXvHd6KVqd3eEuiKfrK4c7Hw+e6TaTr/syxEL3GyDEi9zVMlA1RE3FzCdt5P/te2MX72e6Kpm7Y5XxICXrrgSirl7xIZMem2NhhRWOAy5zvGpljI8Jylx3e+yvdo6Lwp1hxYPjSH2gASRYRrEipIF1CaaVTMBLJpEolO0Ui2QZpZJJEOvySZJF8bhsmkgQRXRC2ikJET07JJA7FBjHB4cINljW0XFEEkC0KHpmTRiGB9hU8pSa+RcGZCO0zrl0slfGeKfzDP4Dvdt6jQUnkN4Y7+teSKvE0oZ/I8i/ISS6RznED9GaL58rhPcb8to11dP0uSh1PJN4SWZIUurwJ3SogSukizCo4leTG8yw5j2ApWKPEtmVQiynFLYI0IgJNjDtEkI6/RUIH4wuoFvajoI5uoVISqR4e1BjDVCjoHLXq6aXaoiwbcxi27D93IcsLUyk8lSnsxmsjNkd8/l7/wb/u3dVdbREbUpOO6H5wItcD77zgKZ7REhQ5QRQXtVIgWXC0vY59JcDod53LCwg3rt5HvpUcrI+rs/GjIBEB/vLbj28LTsnL7mWXlxzo3wXJsboviHln1ShNakpEjv4+md3yplVaIjTaSpqSGi2iMDrXWA4iIbuPa0B2HkkdKukYW417ZE7RbCorHjGzRy5qzSJ1Yw8y8axHQwlCirXSuKcFTx8jnqg34hJ0XXjWXfWYh8/beJOUfcO8gmhYLAlOY9RugWnCmsByGgVuBZRNeMWZi5O/JPKV623wUzIwSpJSxrdhU0i6OQ6E4n/pXarVGvh/fPxEZDx8zXqtaHfxGzqEj0tGpHAh+/OrpzETRNXxIoDwL2icl7ut1n+Dlo9UhejHc6j4qfALJa64vTZPO6ur0EcvwYJ5UpbY97quXSzGsyN4SzHAoMJBhkjHfSuBcTA7M1VDf6TA5Dak1pTlw1tMxSOAveJ1/aBYKlU7ln0RjVycKINCrVDqNeSm5xy3G0J942VFcETz2QJN0AncG/zmExB9IKTpDe4/FQZhhW/pQBK15vnHJhZAYXDvYf+DewXOV6F2qEsV0wv9dx6jt0GlMuhqx0pd81hRYfCrx4MHOwXdw0IU/5gDhSttdBnQqKBb7OXC5e92PgaHt3gq9A5vxftgGRzeYuvaI5o5io8KPZc8QuyiqqF2hIeMVm9OPjro0ILeh3Og+W5S6RWuPASp7sjY2FoJxJ76cCIO2w93weGtaBS0WjGNQf+LW892PyqQ/U4b9bB9/4ub/Xd+v8xhHtd7TUVedE6oyGImKymwFr778GtA+S2atuuv4Rems82qn6uum+vObwBl02iuwMNv72aaSSX0nd+wqxninGff3kEpfv/rG/wjNwgmb/+d3w/u34mIK/HCPJhEa4TBQQy42g27fka24xNTYNtyXJTyQ+QL46EmdFpFUVyDCjo8RIk3o4g7/OC5c43pLm02rOoAtFYCr9UNIc+2tLmkF0YtXwQzMU8sH96KisnXy9FwpV7/T9vLxgEmZmfVITC2USOEVqk3uL3zbHdbNbZJ0xp2HC9Se7EoUsitL6ckbnJxmwpCiZdDdKMSduKXQZm11GN7V4rmlXaxGP9r4iulgKKhuhDFQmJ1stERK3/34deYk7+785tCLwlRftuk4ck20ZiIo7oO86A+NYXhoNIE6FtNTU7UtBtvLBuhRlsNabYKBu/eklOG3/nz4PP3RpxoSy4RNAFavkeIdwjx/kAv0WPirZv+ylzv2gv3mOSn4goI6Kr9sbgIP2D+bX6SarDurIZx/o3ekBY/rLJcUYxo0dB8hD9+YYWbBtWQIYWNToBl1IAUs+nR+GTRWHXQtaSkh4oV+5pYiVPa8Mju9pfffnxf5K5CcqfIMDdmqNmhs9ZlNNcZ7XVjmepS8YY7k3XtROYCWWNS6aNAJLZq4uMoINj6lJoaCQY/1eJn6BWTn3uKha3NGF8aIHZ4crm7JlhwYTC1nojYW7QlqnQSWkfEOBQTg7ZWLZCaen7iYGNiJRijXVJiWW4IkW9rRjbW1pHKaMFkNVrGmCkiSVBqzJNjUqEZsZqQyTLJBYVLFqoxTdlKrPf++kuj2dJACG15kFylQTRmSqWchdZWmILVbz7qf/0EV6egxliTFS4Rs0SrXKJZTrCSlhXrm1xHO/G41Un1co6yRQp3aKqTqvik5AsYEExMIEhLHjDipMmOEGojjWWwCRrGiruyykU8K0e2wqgUDG8ujPu2+GpM3ABKoSZhJjaEzpY4KpXxeBX0f7E7uP94b3sXDH63u/frO6NRFake43X9JnzdIpHB9jWSblP8YaHwQ8JY1Y116EOcVoEYQk7Pp8kZxF8/pq8SwimC8YuXsoOCJPOPL4tdKXPrIFksnLqA3IsXL/ChxtFcPKAsqyoKK/De6HQE6EraKbRFELQzOLYYsiAMauGyXYhZ4iSZ2JL9uu+1nQBWrVaLjM0tCVZPyYnEYJKv5YuMGcskdXJJO/CiZFGSi0eVle9cqmWsCpXS3glE7cWxIvCUp1ykn4QtqD6NYC6ZplxoS2OjrKher1XB3mef9L98TCsjjWb7kRJEwlNScZ164cMcaRw/78a3jH+N2Au9C+hYrR/lSbzDFST3kXinmXOJwk2q4Z+Dbvd8B7pxehAmgOeH+i+rDmzZ6ieKIsE6eswmJgd7VSQqDRo9HwK4zHCUbUn8kvSJlLN2sUBaFritED180aDDxE9hxI3YUyFRG/ZD3AQ7NhrS4x60NXkWCCxgivO/LaF6LPwPvIwlLM7Tgj5Ow7EQfhMkogN9/COVCqibgQZoCB0Fomc9aJPo3/xuFB6/OBmDHGWLioAjho0biZVeNahkhDQdWq4AH9VTxMc65pSHPE7yrKhisxrxqMCzIkZaJs3MgRm58GA4MRPBaBw1BSl+aJiUI4jPpi0dsAV0bbIcNyiUdWbWwt6Hj/bu/p6rKlBOGQ/+rGu1TKM92/0MFRPKPprrhaeyALh39x429t39IN/4sN1Bj6FrR+5/u40zLz6/lRvmM9mG1UFMDGP0QaMAtmAzwyKOnOhn0gb8T0jsjg8DYqhe3N+kuZFIIgytv2WAGV2K9skee3cf929/C/rvPBh8sZMD6BW46vnQBPX9x4MH2zlGs1aRemAcbO832/8JGG2sN0rNuV4Fpy5eHOl1NdyMbFW21+y2kT2NKDFnWhD9q1jAbbC5Hv8NB7fHsYLLY1Wv0w0qthWs44eDKTU7XuBQtYD6qGjoKHqfuwHqtdoPyA9tx62sk8e50d+LMxO1znVUuaPVLNZrtWvryHo8W+tcZxEsq54bVgLnn2AD1Cc71/GJSGC45sCNSmitBBQGm7wi3ACOi2yTldUWC2BdszoNgDtTI9Ka4zZADdRAfYL92rFsZPbm2q3QBwbqnesg8FqODa5ZfrFSWbGaV9dw9Eyl7dnOqgP9Cmlb4jtWfMt2UI2C2WjAqGNDHSqATQ85ADdLGhQphjzxJmsK5FOd6xxCDPyaFqgZHVChb7kBKt7shszL3UJaEQEWcUKl3UXp2fRr1w/Q547nuCH01fWaqE5rV4zeuyhWiWTp+E7bigJ6VXiIdS8i/PVKsG7Z3gZaXbRuk53rwF9bKdbwao+D+sQPeL7aoMScqdU4MNcd24auzFWu50JwyGl3PD+0EIF6Y2PjR0Al558xcATdhPu3fw/2bj3u736Cfsg7CDgyzoANPa+1Yvkp+zDCIt4UP+0GobO6WaF29QYIOlYTVlZguAEhzTC3Ws6aW0GXVlS4CsarjHdUvSZuqcqKF4Zem3J8RM4QFfSqWD60ZJLGwAgTrVgBRDuYm+qYOiLbE9Fu5tdG5sTqxLQP21E4ewgrGFu0qhu+1eHGDrptxHCRWyJpA3Az1KrHZjPOYOHrT5CRGArVpwRSEFsHHYtK24lYNkTSoh6LhesIZCwwqExY8XSS5LhRDnJX82Hk4bRG9JiHzCUAkoSP0/Tcyko3DD039cBQ9ga/CsbloeSPaa1SP6JwzXTGKDI4A/VGLriNlGuso3iZsvrBKNIzMAseM32BdfCI0wqdMWrkc8VqonUqUdfCcEJ778595Cp89vUf997/4z6FdsfrdDuVjuXCliK4WWQWq+eFVJdIhfinCq550AATtZrEUbMHtV+P72O/8icyaUr+VREWlJhHBHr4ZOfUhJ2FFMZjM6LCuAEq4BinL7at64KCOU3aH5u4xtIZELettryNymYDWN3Q46Wp54c6MCajXXfwkIwfwdx2d7v/8Q7of/lJ/+eP+x98AgbbT/q/2wGDDx7uvf2o/7uHoL/7JS7N8BgM7m4jf+79p7gjNrbjAhPbHz/76g4YvPNo8Osv9+7eQ6PQTjtP0VikUMUY4ku2DrBlZ1uG41Mq8lMG5JHmJCLcYA/FCkwQTV5BMSjQN5+Q+9Jdoh0z0bmOT7oZcedEakxuxV9Sg2YEKarBjxcGvE4jnxKaY02vwmaVoAQWHxJ8Q29tLZrbfChmUEv4Q29iSjn0EMFnR329ms59vcql2NWjs1t7auKTl0nuVgvUJ2rtAEArgCnkJicpOy/Jl/Tzaz8LLB3ReaZUSZsDOs8VWyTcvBK2wgzPO3nU8hmslktTEPqs+Y4tsz36jbK179iVELY7yLdaIa6DAF2sOtAKi1NlJAdRXDSKpVj1meDDm2Fa2vn4eKNTGLZb1n02K925sIJQV/ca4lvUmNsfjBk6Q2y67PtlwrhfdGswBBm0NiX6Y021Mk2qtDmWeL0ZUg4dG5EcMl5oIsMUbobJ08AvYiWIp/jAJUYNboD4E2y1nE7gBFkur9zSiRJsKI1fN2zVdgJrpQVt4xV81XISJJOO2BWrxTp4HavphJtINEzPipSz4SqKYtvfLeGXO6iqF1XfBtsPBw/u7vOyQGRVywnCvLKKizZJl1lTsn0U2c5qkS3n/2pD27FAESl2dLMdryGFjwJlgDVdkE4agOoZZp0ZyawTSbPyo3od7Kzej7EmXUZNzGp1pZlRy6iZoWRUN4B+hbkqY2WeV314bQJJZqoDlbmJlI/J9ijtMqQqTWaCCFaGXFJDC0nV9q21NfQ62JYsVqbUNUPuEminGCYMk1SG1RN5JHGPStu5XnRcEPhrK2Vzb2QkLydxhdbaXqMW9+w4YuTWLdeOlCG0q8hY5Da8T0V9zbdWZLMbqGsuZRwkDdGgxI204rhr6joRhrXstSQcuM1fn5HvSfEv+L6l/iybY44fz7SLI/5HsdsE3Ly63PG0uyaviTDZJ1EIO1APQHwSOtdBnecVnQoUOQgMoDlupxsuonrr8wVWVKiwlLSa8YDJai6ZBb/AtWXAYlT6mbIXDCs3XauZeBjbU4f2SkRav5liFaSrKiY3AkPbuwYrK6E7vBEi0WTPNt+ssvlms1vmhztyJzNt1jQvh2GDzibaJkR5YqQ5OVQbrhcWG0z3Ln2vVgIToNLNgDtzJ6bNqjz1GaKeIFxfxAc3+sd8AVUrLyxRJZLY5Bj/aA4AzWBJWsC0qb14oMdnKEo/C6nWXct0jvoQsYF4hiY6Eihvi1ZdZq4UjbzHZNZqei06oeSKqNeMaqIeUtGJJHyq4n/FBJXVx1TG4lZgll8B39ugW6HCkk8lA9Nx1Tgp2Ury+FF0E4/Cqi2ZmKdzW8SIfUZLl5YTgycYWaT9mOrAzoIIPjVmFOl7ACsgAI0PobL2C94VZqQ0hr2gbbVaok854UY3mWj9PninOr9nBCNTig0qPczHSJSMJiIeMsU0xI9XpedkrhHzHTxDG34+2xls/wEZflCqGXoRfPDgbv/Bo30af5okuaASh/hoWBP9rYIUwQaI1cFkfW0mU+gOm7257nRG5R9KsXtMqibr0e2SmVyubG1IHjXmcxShcxDtdtIAafJBjv3OeYckly9lLH7NhNsXJTEddUJ7chj3jdbCr78UpsRXMVTTwFV3ajKuNJi+rPuE73iyhJ6Ot8D1+Ho+nStQauIguXXqOQVK6ZxV7W4rdKg2lxBbmNjtBBCD6bjr7/EJxV2cj/BoUyAPM16BY6O2k04Nc2nLdEySe1kQVnB0tT42YkSumsQlaTQqG3DlqhPSGs1BpU1qPGuiXrOPiaP844oORPkrfHdnm9ZyNl1O6IXkWLo2q4eEmEuDlCsQd2OpTdS4axGLYvkBOIqWPqpSuxpfknQ+F8HuwTH3BB8YG4fBTMxEP6uBP7J/8vvwTWYM3QpSl2FfNr9jWkXhWBZFQd2/2k2ZY9sIGJm02TyOTu3o/PFEeSjmCkYCrQFSOQl9iKwlBxvgOqEEuE6kBrjqsxCmmQt/lMGsBpqMwF2dHn0z9O3hvTuD+4/7T/adDYAMTZWg6XstZQOutLzmVUMIRSSQrvOMxoupKGCPVyUFM4Rk7ZJmxz+KYYTW9cjaJsfu85Zy9WOsrylJGckpAbE5E1f2xEYt/DdTSyQkqONIbkFI3bI2vW6IEoevQ9swyj40Qm38h2jXrdY1lkZfVHalaSXLT0lOaxGNlmXx32kpX0NMKZ2UebsKRwKKE1OXwaxRMolEqblP1V0JHc07zjVUgaxptZhXre3YdrRv1HNLQXUYLdLz7cqKD62rDXAVwk4FxTEmckSjZQX4EteyZebgPol32djmLA+34tmbY6HP9wylzpyJWgFGYccgdJpXN1Wrd6T+TQ5pA8h6r0p0k8YBW0n2co40IPRHE2k15NFEn5v89gl6bKD/9eP+xzv7TlmzvQrOHuWzwvQW5zaEqBYCZl6SPsjy3bRqiqRuKpaxOIZSNnzh6xnopU3Le4tJ7hXyFXPeaKLlC9eBiVri0JE5XQY+Uoc1DlRluKuOa1PtEmzphHNiD+6qnuLGY+wenW2sSacbslAbjHgp841F1gppD2zxpT/iRvJ9hMxJfivNKYqges8Wo4nxLU17GUgiVaUN3a6WSrqb1FA3OJkeBNCk+5h0PeW5nAs9mcXjxBHC5J/qZTn2D6rX42l0PeZEaS0Dseh1MNOGjXk+08JEm4gE/2npgIOjlZ7okIBhBa1BJ205uUNgNAs6IS7ERAKANBhePFmOTdcUAXY8Ucg0ca6+fgmeIytjILWLhJnRELNJIzXrU9Mo56g6Pb3ql+IfcSJSdYb/cYKkWk2sIhD4QPljbE8w9XlmRtkTYIpJB7ZQGYSpQOhKy3Gvgi2mLDjuOvSdkEOcXnuCOaIa2LDp+RaZgggq4/DkgXRBwiv7FhMZo4tFQJwzmDSuhUdNdQYQPly12k5rk7XDP7U918OblbWJeLVWy7uZkQRJ25OyhqMPk+MvUBywXYe4FXFHxUHLVJFVJ2QX1BQMfur4FvZs4Dsh8/OrJxK7N9OFmpgQLytaTlPVxMRpma6Yk3pJQy7aVkh+rET1vuYLVtAsLEUmX87cC757/5eFuQyslH9OGyZM+nH+SeF1RPpKG7a9CrSd0PMNZ4hWYxTUOmU8Wkdb3lS8/SoLd6bBqz1ccaXQBK0gRc7WiUidFEQqKdRSX80O1AkU9+Gysyu3zGCbJRbcadMi2pIbhSDjpzHOJM6oEd2w54QbB+hpbidibY3nW0OjXtPFxnA/f0/laeSgeI5ca13HhnkLZ7BQVd2ArPxfYuADuXZNxs6VIaIhjqkQ6AproMTnSbIPJqeubZTU6O7Zms57oan/MP39paBldhSLBPlZ12lexSV8dNWI6tpqRLN/UxhSk8T+yrPMqqzEEj+DDSeMWMrsm+GDC77vFMVERITAN8FbN6P11h3PVpoqW4UT/jocO9H3KXa0CKZVq9pvkDOZGR3EzHyzr0ArHVrc4GKUjPKZd0XqN3hqwlbimExQTswawAxgx8KFTvMfJIYRmy0YneEClx7Xcumx7yfpLk8GgNnlibG2bLti3JumunH1NLTNYf+Zhcw+igZkj65JKC8gUUcwqxNebYAVfDdz0SsW9WptRtmoVO0cPX2/56NwtEQWqDSiUhfJIZR4WmzNG009k2OJISSJvptIlxi2tkScEj0xFd26SvpbA8d6tSRfvuyynzUo3Y11KyhyPxLYcHZQ1Qki17kdPd/LQzBFuF8clj1tVwnWYRSVoPdTjmpvcLekbJvDALE+YyN1GeurPqY8+ku+S6BoiJSLeQ5fmWhIhU8mxAkQhL4XZecoJeNSc0JNo/JxpuxSHcDWagNA155LOLq5y9exqQTec61rzpq171T+9NGVg4FVBdRuWYMOMmuea1iZciySKfUJWaZwYM5OqUGK15WkTRF729osaz9sQHgVvW2+NRoe1kdq5MoFSoJPX2ood4GRIRLWFdtX3o1EEana1malVjYtUsMN10mARfGYC46C2RIwtDQH4pNCAr4Yi6v01xwN9fqMrg7PCKR0FfsMEAlAdnCmZpNOKhs/8FDxumEQm7RGwAmsck3ytKHHbxo5QZSUWpjIWGoheWn3n02YwMMGGPBTODlCE83xr0ivrmnsaiMrmyLl35joMZIiK1ntGYLCrg8sklxVqH3iatDn4ivoET7iseDwr5i9F73UER230vG9NR8GQdKoiY4a8+jo6fmkYYmsWvMhdEtzfGbwsVnZ3i9yJ3JblBM+Yx0oqQHy3iTweM4gvTRQM1e/zVjeI3X3Ckog714X74dURNTiaaTI1cnplHk4Oq62PCtsEBf3XIbCYDyeCZIePyWRqdKYgFLy2aHcoXis9IcuD4cp+UZz6sUHhfkqoqugkjbmfg9SPL2qBE9MabXgKc0FaOTOkYx3Qlkum6tcTeiqXOkLgHJEES7RGnrW+LsIuQIRb26G0U4Ack+XW9GLVinLkwbqFCMrQpUjTUYF/oCcsJogKjXDU5O5P/w1JlXUEqxHa8RSKw8ZE3XU6Hm9GyahXcVpW2vQkJ0xrA0yjqPS6kvKPOhRYcu33CY0CFKezsbUrkSE00DIa76kIDXX4TU/siFEHpMhlXN5iq4bagTzZJYChLlrkOVxauiuuxkQankW2mk+zHOn4HWW499/nEWOyhy5nnGo76t+m0je4Y34yfjmffyB3yiWbedadd5NM6Oro5yHF4SajiNhhpH4uJ8HU8TkHyVX5Mq8zCBNhQjvo8D0Rb3FSBUR+C5RUN9wNuQZXY1dQdDmDmDIdnuLfFGSvnPs4PXu2X3mnpOyohPSQ16zPyjNJVZoY3jvg0MFICZZTLjwnFjtByXtpFmriEY9kirJzWo7ILTsblI5f95Wm6XYXNy+nER1DSxdfy2umWcGxfMtdw3mgoZ2yQtQ4EX6kxmcTdhqeRu5wKFd8oJDLFUacIx1eXnbFZie1RXklXdfLkTIyDnxoFIwj/E4U0GhFEdISrgLgQxeD1NEXOTPIrGhlru5sQ59qLVMTU1rZyG1UjJFJkVnA6uzEmUcG4S4DIF4UFQm4mrsZhNiIoocIBXPd/BVOQqGFlpgUJotq93BybIaQqx6XggPNDB6RmdiQ0uAE1Xy2ut0wX6Uo9uJ5/kQwcS6ALwuFIpED3GfF7zGE9rb2sgj17Je84Z/XKeWpowm12oRiZt4JKZIWnTqganpH5R5LTxPIXVuGH39dKbh6Ghk9qrGyCWcsSlA0TN0BOixkeq14TCMFAATksZzOwUwei6D6X2jyEbKg2LGIY/FfMFfbhPIwekNycJOSSPEYiVc973u2rp6fWt3UBah/fxlUppoyaYP6ddGeaDA7AxMkkNZJA5WA/b1fNRE0lMsGocVnZJznh/cjW3faQIcrCd4D6XOSiNpa5Pmi3Cuw12CgXdYJnlktYqTuVgiPxXKTfQd/rUYfnscm9G+0PX9hwRLauf0dApB9I/y4LcwxUd51Dy6sv4rzfIyfBXTcRRxFIQ+DJvrc9FXrLBFKaNYonTbLnvcR55DyPLSGg3VPmqqhkECpESIRq7Z5ClYwkZCk6SMhwgIGsgL6mAcVOqJM8s5GBqntKG3IhizuKbFcWjZA2x8xsW1cowkl1xEb62mzYGKhKBXOblp9uvi05Y90sHHvdTdk/MPST2WShOqoSQ5vYAzukK3YpkdcUrkIwpGkYY0ZCxZhiOYJ0+VBE+kYZI1HI911ngXRlxHUS2Cq3lGRaNYjfiJEm0VxnyXPHMGR5o7Ykpv/zAtiu4ZvP+cqzJzAFfv1NWYzLcakQeobFqrv1YHEXcCtD3baqmJ3sdJmPzxmTjRW3rQ+xhtUcMPemvHFk6w7JcEMfsHp5yXpPuCxqU5qy07jCDFbyaWwbHpBEilc3Af0fYZKhzLEXQyIGLh8CEen41rgEaZx+bZuFtVij9W3tqGJhrn1zDhvdrtqru+mGOkJzUx0seTH5I1aAg6oo2iIrJ24CrReqMIueHfMsxixsksl8xAi45h4xljeldmJplBOe9GNr/CZELErezunk72KQznNphIQifRhp+qHSa9JsdPRS8jnEwzv79nElPmdaGj83G7xlXP6CmKeSJasOgaalRpkoDj2CZnLsKI/AcGLkw1MoiLEAl1IesWIae5LnR8WJEvDAbKWFIuqhYMzZxJA0ekHIbuyXwihKjU0hgzBkQyf6WcORlsdKmbIrWEitarJkasKgyP+8TZoDwxdKmZPkQalUG3m6aaGyniE/V0PdZFU2dKP1J9epYMNSuoieyZk9lrG+KOxppljc2+rtEs0c/prKeC1nCCYqdMcldI5kQZrE+VUQFvENpltDGYgU4ZWB8Ezs+BKxEPqcZOTkYJp5FmO41/qlWP8TXG6LLUSTFHPkFavW3VcVWFGfFmVk9Nio/PNi2a6LBopfCtwbiY/MJ3zSjURi5sh6vjpVJhfUoIqCD33jgWUqtu6J24aUWzEVWDdd9xr4rJKQJMPsTZKcNH4GV+lXA2sSRbJuhU2mXsKGTC584U50fWFTAzxMJOZHl6SfdQXObVy1TJzbSzpFQGQ8ZGLjhSXqhJhWZyv8H4PFDY5o4940NVmois35pSdjrcxQpQuhZ8kXMEXPQcdjIb1WTDmaYWjpRVkFJKSgec+iX2ZwtJM/Ii+t7GMC8jiomNed9VS45f47EIreCq1ryZgy1zH4eotoM2gGyzAcgrMuR38vcVy6+sdUNcJyngHnSRytqaZZIQP6jTNHWvh/PGjaRnQwyPwSS8uU7ftDE/KHLsIGoYzgxb9UClJM2NKxvYaf9h6vqkUSMgfF0YRQsQ9obks9eMqE+A2ycKyt4QBNPoUuFyZYYNnwSnGvDSKfq9p7ppIBtZxlstlaus4OqQaojOyCoKn8wSJwOMujxhU2K4Yd9zuuf+amMqx5TvbQx7GaTuC46KmsrVGjcyQ2aaBrNP1PIIKUQUvgylfM6YUc1kek1a8szx2fw7TPg/FfTLqIywujWswusdy7WhDXIgr61jIbwOpwOlizIRksDhUjjjSzJ6jEEpGju0VB6RxzotVjBVXiYT4WDksxIg2nVt6KMVMqrbsGXv58I2lVsX1dngmU45ZRZIiCwtvrTb92Lrns14QzA9JDupei5rQF8XI/GY46jBX3LzeKT06lvK7ZKfmK/bknzqGNxT0lPlk1lmRQfmhudfxVYUEwDZNRPM/7kPOVb1kfzFcMaZlVWhZOzMX0MhYnPsq0osU+nDiSlzRE0cPcMJDJ3XzxiQorGmCYd8FptwvFDfZyhuVns/inlTE940NuapPFYLzfscqGUp8SFzYffOzA3hTlNOqjRvnm69+Rdn1ddl1WcaIvuV8UHYPPa7CIr1ctJXW1ZvpkeSs6UP4pDfEQ29TkJxuFy6qVJRTocteb8Hf8HCYb7geoWlcq4e5DoUGx8To0KzA6EKqKmJ1LVNhY4b7vgww3HpA7oxJ8TgLlZUdqY2xFSddSuAuknqE7pJ6rPDTEJq9GnJU8sW55txGTw7P2N5tncau6q1APJVyjhaZyBD9BptLhU0/elavUYWPexmOg754JTY0DWVzaySpR5PbMbT5IRgN7eYE2LwKGcN7dffFHrcBFk9+Hp7jtkV3zMgERnty4YG5Bpl+irqK0p2wJQxO4CGN+i88jmuaHW16lNdk3e96vltvT6c1zVhHPeEsZDlUDVQNC8ScJNpnkDhvmIzkelj/MKY3h+W/tL4X+XDD4ICGFmY90NA3csY09pXsGYTGUMiuFBRujZtrl6jvPamjUPTTuzDn3UdPzK6Zi1/TXZkauhTSlyT6OsWcgW5aBfKEST6afhC6LSOrhBzEAmfac0ZeFwTh6Oz0e07I+WAWNxcRk5/VIrVv0ZwXgoT43sc5YM8dcxylg9O17RoAg0Xlpskx7RBAOz5gFnlqj+lZZlJM8uoMfVJMfl5HfI6pMUcFv7DqtfsBiPPXtH4dltWgN1gzavQxjzhe61hg8kj2uoj+bVTmRjB4FwRxuDr1RuBHbloMKd/cVlaU2Z2TEwS45O6EpB+Li8bUfw6vuP5Trg5zA79W9mMDEfthow+Pr9N6bhXpRAL/BMS3OwH22t229CVQzGin7n8XfWEkN1CY+NHQCXnnzFwBAw+e9L/003Q/+LtvbcfgcHd7cH9x4M/30Of8g4Hjowz9OH1EPqu1aLPmR9o0qUSOzZRM1QOmRKyl+Sn0xVzYj5jsoCyyRMXXdYyZTkNu6b9dx7jNX30ZLC9M7I1jfgSIbiPHO/E1c5yCuFNiigtQHTAXFZXuKw+ei6bSOUyPe7fL7sN/uNR/7dPQf/fHg3eeYRY7d9u7ZPVyBWssm65dmScj01d1krgtbohVI1d1ONbiRgotnPVhOU81jGmSzEnftNrUTg48guAEarTJ+XLuhZV/C90WLJ35+lZx96eL8xlxi16UUbkSzMiZj4wKQ3DMsDepw/7v/gEDB7c7T94BPZ+uTO4vbNPDiBHoumKk+vhtZQcDjoT7/Ee9pEVOlSAbZSZ6mPpglaHk1O8LX5GYYoZjdN0Mk1+DSdI9MqcsYCnaBnnKShprULuZj13fB/L4x6Wx09dAIPPfzn49D0wuP908MVN0P9qe++Dp/tk86avrdKSlb8nUwLZmn7lmtWKyhqO/PaPgiYqLW9NfNP2ebB7BuXP+ExFZq7PcktJzTk2h/BL1BvBIZ61Er40c5U3YXHloydmhStsCIMQd0U9D7S40IEwq4QAZ6mQEeAsaMJldzqHxExYrdhGvc93HzVxF23P9TAB0hLkJGpwMSEjJPywwvbZV7vPvn4KBp++P7h/Z79XUcTbSC3rtsIc653V16nYPTJs11Qj1X6UceGQ2rtzf/Dpe/ukIPZ+YkRs3+so6viqcx1SFwQuGh5JWE75rjHHcxa3RqYDIF6oWpK+4q+tWChwnP6vOj2hz9oezj3JZXPPTPF54dqaPzN8zZ8cL1nvk6O4YpFZDhXzcwqkKflXhZ0nbcu/ansbbpSOiiSVzz1jhx47wfUYS2Vda0pWXftI8YtOB+0Fmjs59LHSkYwjORJigSCmktQNyRlo5aZI1v3UDJd1T+Lm0I2d5JMrVw0x0gD9SjLhKitw3brmkCumG1qOm5ye/j0/YpcWU6cn7mifiq1Vj034sM3uwSiLEENEtLtqbQp9M0GkKa6qVMPYl2OUjzrGvUW3dAI4UqkqY/aAPjYhYeATwHaucduHZ+YJIoYmaxIzc7CPgI1Z8P1MQh0XIw9h33LiYuVgndkZX2APLPMP9GFAyfU+lfb8Xx75LqIROmFkH4uD/5MsjGJ2Fh6k2fICeMDWU8XeNnFsuGva9AiuaeYbWUyP0VhU+aUihYwP8t2LWX3Gx+TB8R8+wr1OStxKntc64mEFk0LENrPafAdzHfN96k4zB8Fuyf5MmQJV4UGonEZdPXSeKz9XxXlCM9qKJUMCsthViRabknGK8eOiD2mqhaiA8bFasdRPK7k2pRy8GLZ9VkY4rh8VuqGvhP3gZ74SqrPvkx2P5dLktWX2I/iHLzuYrxqOOrPO8mIuGSapi1m5XutWS9GmCHQQFQQRozSTgkG02Ur5DrUDkzJGN6KErRg0IX0k6eTuquNz7x1RjDW7sBZzaQbJo1xFtGGSEURokPgS6UOUiRqFW2rzUzKPcQI0Vh0fh+k4KFxZ0Dxrc6CXfRwa7SMMw9g5x0jdVjljS0++aqHdhC240+zaxPRyqtjhZHnyXJlyeapIBkF9rpbhYiin/FyFsFOxWvpMIT5X3QBCNfJ4c05+gbFIXA36JfXA1T9YGrvocd65LGLw+HGbUkZQBQ3SALBguB8CFp2uGQE1yuyNaHzLtjHCXGC1UJhOve6IF+rcB+DQBx0PaTbNhPUInTZMeRAwZ1lpZQo+0D2xMtax2SwF1vQh68JLxM9VRc5qXRwqtyBrweJpHTOMIsZeW+ZrVlXiD/6lw2P6G9/EyLagDiHsgi9rfscmHzO6ptseWRPDfe+49r6X8MT6KNwv2S9aKU+uZ6vMlHAPFGiT0SaheyI9YdQq3ZIHdcFMmtpGlQt9Udb6cmqdOjz0fc/XFmA3Fnjn+oGpWsY3cZPWwnYClDluq17zaXG5bbhqdVv7C9Lt794b3P/l3r27Q3vykpIsCY4dr9PtELd0tleYos/kBMJv000a3qYT3lAic3C38nxzTBjn0CeTzkxrHhjjjXEjfBlMfXIs+VUw5RExnTVEe9+SKIoKXJLiu3zCaBCV5C0r9OfrFUexhseiEyUOOeQeoFL2JoVi/AhpcgQHG//LU+yFvn8T7H32Sf/Lx4NPPxps7/S/uAMGD3b27u4MHrw92Hna/90OGHzwcO/tR/3fPQR7n94a/PpLOsp4KrCUHE2r1SzWa7VrG6ACkAO2ZHjMq3ZtPT0XeDgWNTxGNpLtlJfVpyYVVs8NB49Pb2x5bmyM+negX7U6Hejap9DNthiEmy0UZTI2Nj4O5vf5B41Rn6hShgH9B7dQHPHd7cFv3h3J8AiHIATIrHrJWgnAPLCvVWGriPEs2M61AtkgBfrfLRAhDXpjCEvWtdpsWUHwqhOEVcu2iwVMZGyuDa2VoFCaY3PhwiJvOnDjJaLYiFOSU4TN+pfffnwbDD59r//oMej/+5f9391X4WjE0BOIpAkSAePh8mwvI1jf7bwHLnmV0x7of/24//FOFqCE0bPC1IYwdNw1DVgRRIhIn378v598CPZ+fWdw/x6mkQmU0tyYMmR2+pCzIT+L0J7aieg3fh7kuzuJrtE5ZmpE4NEp2SDSpKQ/fWQhbEF8Cy6MSbNLM69Pivz4YHvw1WPGlnv3tvc++1ILUYQIB5OeCOgLRwLm/xbBQOn8iRSQ5qOjaGek37g52Qm9D6LTIbQT0m88ktibfQGu+jBYz7Lp3v8PMHj37b13d9gKPNv9w+D2Ax1cDBlKCHUmM1vgOmdUmS0Yu1M2If0uQv+a04SveRvkRAf9f/99/+MH4NSF8YsXwOA3H/W/fgL67z3Z++DJ4P49ikT/X58yBGKSYK3nLLaBiKTAdhF5JaIDS8W8HH3rtKwmXPda+DZY+MtvP/lFRL6vbg7e/Xm1Wi3QUw0jG4OQQCPcqKB0IDHV8xSPH8NNYsFk2Hl+mGWd/5/3MixpNJYZSqcZ3UoKcie2zQskNyNeAqIxZgHz3jfpYPKj5QBU6BaBund3e297lwcVtuwskP7q37JAGg2WC9C4l7AlSK4L2Lu73f94B/R3PwR7bz969mQXDLYfDh7cLQhMcQ663f3IHTaGGXCi7GFlmQ0r3QMK4khYiatSYw0iPjKJylyyX7jjUfJDzt9sCvJoqdDDlr1/4Okgw8AeXV0K0lgpkNPU+peGUkPizmaQaZsKUknGJJ01r04ST0u1y5dQ9OaQowj9E5Qa7pVvSbOhip8wP5kaTStOGeuJmunITPQ7Dn3H2iKeb6T3nskqS7/uP7jT/8Un/S/eHs2lZ7XrYuEHSIWZs9Q99arjXi1SoyoqPMjZa1+z2nCMXSB9GHZ9FyxHZ+yLlnBJxeSaLwher4LQYt2Hq/OFw1swaFodeDIMfWelG8IimrfUE9viUmtZO5xgTV4J260iB3yp9+K4dQK3W8YmNwMNzjY9N4UO5Ad0FqAN+pfffrxdiEhDhbq1Cl+3wnV6GqA/WsDnxqROaPiETjw+tO8wawESMob168QQSloaQxt8LLLvCHLpu+U7FokKNjQ6cXgL0Tpl/c5cl3m461PjFoYgWiFnFRSd4AxK/ih2/VapxOmRlJgs+7bHL0+zBS33Db/FLc/F0HfcNTxKNfSddpEtCprjkBMwmN7wW0XWXTcfx7FRMwGCjIssFldQiw9k24MRCPJCWv4aDOcLV1ZaljyWj1bP9bwOROLT9Xy4Cn0f+gZWkKfEH0qJjJHa5cRffvvJpxKPjEwST1Wj2glEIO/duTO4/YcRS+OO5QfwJ85VBzMxvkzwXIseT/JWAblkHJqfB4UAM2BBw1Jul0VWCEzctsLmOpgnY0R9KPPG/8bNisJqjL91efHyYnHxrRuXl5aOlooLjcs3iotv4X+UFpaWDo9HzYVdgIfKDmAHS00C52J9SdxWpAknBLm9SHpMLC3IyNy4AdZg+LLTwnJFkLsUlBi2WNzLRx8GdLQ8NV1FyVj93Xvg2e4/g70PH/W/+Gbvznsj5imUU2iFb6L1VjmKyUHyIV0Soj4nfd/arDoB/q+5p8hhlKs6RQ6ckviVqO/FlzwPyR/p4089xy0WXlzxTxRKCkSxp4LfIPNog3grP4XNMBYSL7xAvlbRSuNfNaCblKLY68lGKGt+p1wjfJF4MB6gxG8aCS0VG812p6vIHTTqiiioqWelgkZZ+bkgFQT69PGzJ7uixOacLBSPeNduULHGbVmy41SRNzcmoMd6JqJkXi3iFSJDaBZN+CzveC1i6rnMnd8Mg1EKipmqUrHngMXFaaoRImWYUJNjCuq3vmTUqrJKE+p6Qa0Dji10AkZYjQWNcGmARfzjknBUIL0xYMddMCZIIuTSBfMnJKbi8UAtlI2kQUfD87zvk/05Ak5boYVr8+KN8Gz3/uCrx1KbcQUaZXYqFwj8OiHHCTv87n0k6yJ21uCUdLYKIKERdTLOIOsiCEqm1jw/zY2ZiJ10S9PCqN/qunPdsNM1S8qJ5Zj8GqksEhUr1EnkFJScJBairnQiiN+48Org/mPkFTWWalP6jiu/qQcIBlfL9zkPkvh2Ai23bPwsyBNdA2lNNOtiptXiIvE7LC0lfb1BzLX9f39P227csLCGM01/thGyahY56YzbxybIcO5lPv9GsRJM+D3bvQme7W7v3ftWulI92/3nwf1tLcNTNfmrP6PYEHQWfv7R4NPH+B/b95492e1/8An6Ovj1LvIq9b9+PPhsO8c6kputYRWtTqfahqGFbB2nrOY6NJKxiuWeH4SIlojip2EQmhcnw9bA2+Natdn1UbZHsbSAtGSY2BwfkHi9wcICKBSMjU2sSIhBhhgxO5KhU5iRPzwSMeVGMyM5cjYe3H44eLBDeRbx8uDudv/2HcajEXMO7t/Udd977xcotumDJzjKaefB4IubmRjVYClKPq7UTlil4ZRZ7s4v3b+4OzzWoqot6K6hu/n8PKil63aqxQoX46eGKk3ZyMIJAXRi8wvoxa9Q6sUDjaORDsTKc6wKBu/dPGDd+hRsUb8HCayi1uQQtsnffG/jLKqOIpmUO9YacoJS1WYNzskqNCe+yMDEG11EjcuALjx5eHnDQVagIm2GFBp+QZtWAEEBCZpCY2wfux5NjOWVYcPH393IqC5cOJFBT7lgSmCSakU/8fyrr3prhYYkrwh5UMoLodxCVWg/pyh3h1DbGzfIX6o4eeeFFwD+B0pOvOS0Yb4bgUbFtkJ4MUT+O35UsACW1S2iqUxVED0cAmQ9ujeWQUMBhZ508HoYT47xyzIxaqiZGL/llTSpIgWiTYzKUCRMiIqIFcz2YjS5b22glYrwuHED/PCHpZ4kR2J5QuneM3ymlFE/vzhuO9fEQZf1dg7MkMgBeZEGF+nZEUVKonxJuplRh4BJX/QPdClF/63Schf4kkE7FUpUDusW13Ff9701HwZBvrEdVHWHdEwcn+abz0cYHOWmHHbhyaMRtDgMrh13eItOhNQXxFS4UFfBtLIq84pDel03DCJeGnyxvfern6MIIHB4i+LRe7a7A/7XN4B9e/hLdPxEmKHPhrmj+U989+ltbkD+jErq85E4UVK3xG8kJMWsd2124DwLikm4phlIiKKdzd2wDxC3R+1YqRbH1ntr12DVsdFeFaW/7PvJ5DVaPrxlHLDH4lNx0Cy6Ejx7srucNE2yu2l0c5347t43L46TxfheltOy7Syr+Ve2kIM/ffJs9+YBr2DKJCf+99Pb5qXLeVA0fcP5sG4FVD/R3EixWN8gnyOd/ARKxRhS/tJCs5mFK6scmyARD2+pTqdeolAbahtQqBLviLqipokdDm9x5JcOIGPHlO0UzY+rHiLeZDp+ls2SCG4MbLpRABSkOsVfqx4c3Z+G3JHsEnNH0+75y28/vr8/ycczolxiWAjKShOOeF1Y4yGWJUo1EIU+DvTsf/wHlINwIGIqfV6z8KJpEiMTYNB2cFjg67Qct0GcUeMVmGfhMuS2io1TJZ2aycpGzYNFFJdXOOU7OHcd/f0VZ20d/fcctJ1uG/3tVW+jsJRZ+pFnycbSeEt6HUZPUMxDUsvMvET56PxK4NiO5YKopvng/V8Mtv8wuL8N+rufYCPRrXsoYFgZxXTPoeTDPi7yd6T0L5t1UdIoUQzgJUNYkba9QooMpWteDb1XvQ3on7ICWCzhywYZQPqwAApkYaCN5W2CqD3BYEC7o9D/f58MvriJyNN7cZz8rifLckljSeJOITx7Dtanfo8kA8lQTnZqkkEWMdUfolo/bM5Pq4fF5M8dPSxB2/Kx5VsCJMmHmRCpIUdsLGRzY+ZAOwH1VPSzuQozoE2dhzq0Db5NTbCHybOqC64YSzaR/1XTVACE1y7VjYEsZRn4kAJ0FW7S5WiuQ7vbgvZpNMCYhqZyD1TS6RR5vy1Tex+2oBVAdXyz/9ih+VB6Gf4i/pxJZeKe4iuk3C6T20Tngay9kLoWzj9h/FggSC9FD+PAyqWLKZ3pU9yHt5KXNVaFB/duDR7cHdx/io6dpJVCXfq7u3sfPqKNC/0vbg2+uNn/4ud7n90d3H9SSNcZ++88GHyB095STnb96b48p3XXcVAfkvmxxHYMZpE508Y28JVqolXfeEy8BeJZzUf5ixmuY8b58VOJyWoIZg+1Uy4W45dPXHCkoQ3uPex/cA/QhUUr+uDm4PN/TR6OV/9HMeaJ73Y+TrlVqXq9hqF6Ka5Dpb9ur6fpK9RToddVMk+Ghsg2IXZcxJPRUJNG1lMlKqkwMhfjbJWmnZKcQJzROGI34xoM33Cdn3UhxiWgEkLK3VmMHb/Vqgs3wEUohSqgq2egrAMfOqdltmihCCXN5xLvo0zcMJHLs5zaLG8cwFj6L8a4ZPK3pSpKmSwWcekrUgalxJMG/V5teU2rBU95bVS1U0QW9xARK1z1CuIvqmLgdtvQd5qoGKhO1wqgix7huIYLDxVWrEA6y3sSFiUxowbH0sPgRy1vxWpdxLnMJHJA8Ej/rAtxir6Q7GzOKRCufHyGAB5HE1GAUNNmCKzBS8jhN095SIrrJD/K7JnGlgI7xhxH/OZjehbhkCOXS1BIwZeGjRGLHUFiTGvZVQPnRQS04fH89EYQ2JlPzEwIhh44vMWB1IvVgarjNltdGwZFskZaLnmZ7A8pioHsGimGgS2NFKhwzuqg0ClxUcgAVdLix3BTn10iyrZ05vGtjTeTgiXklRfWLVoCWx5D4i42i9idYPQmDXeWwpwputKhtgD43zEf0LvjCcGaVioZxVSDNeRHota3atBpOWGxcLlbq9VXCyU1BkgLPZgXcFmsLZHxpPASOqHXgb4VovJqcogJzbcN9NqAukcPcbPqrlrS+mhFvrgn9E0irjceJxwgGQZMU1JcLzw1YlIc+lulBfxZ12oFmqs7jzFzfCUYK+L9n8c+Q2UBmerSZkelG74Z2pku78bFU5XnSGBo26I5k9Y7k9FEQY3ejLHlU71dLAhbPGYDia9UgBuqmBTB17H/Gd2qU8B1C49ZPBuAynQrcNXz4ag2mn51qQA1b5o8y6//9YUXcg2C74HJXJSyM/E7xf8nku3EvshGfMdasrE8I1ldELeGuf+hpAGSrrq8cjTKy+3xKn3qefQ32oueH3Kqe6xoErkmKZpDqnl88ldE0yy5y1JELboSXtJG1RK7tNZPKgfxpvC85PJkxdu0eVuoZxU7A/Rba/nwFp69d6lWa+D/LY+lpQtQUrzWba9Av+oEr1mvFdH0Jc1Rck27cxoY3AQvW2wt0iTpmXwrjEAL1dA757RaTmA8UwuMwTKf5WzwaOziEE6giDkdNwgtt4mgRiuUG4g1GGJLWDIM++IMencwC8n9sIVq09Mnm9DJMxhrUlmq48MAuk2YUSBrgK5pJq3PqfMkxkT4lnsV3QE1Hh8a7NAAddWss+6socdk1A9tHA7RAJOaT56N7l9Q+xE/MTolco8uJCNWquIwjohI1NIjWxs0o1htPMB57OqtoneSHBgUMTHQ3dO1i8VF1GgJmdC4STntDoUYltS4fTx05O7A/1qsL2mBIJYzMM+PT+pdjL9VXKxXppZwcYvTNw6XxksLVWWY6Awg4yxQXi/SH0pIA47OB32IeHajdJrZSrs3eMN1XCWHWB+jc5Te6EjJfskSGRW0lo5V1BjvEE6SoN/A/DzGGcfjk3/Px/YAyvJoeLkzeRiA681+4Lqj5Y0nfuEFbiTN0VxTyihEfTWt60rrxMErYvsWDAF5PnrOXIwipoeL+USoRcHOrBhrvpEIAX6mep6MVyFdKDQAtqJ3GoW2dKeiLqUkIzTb0dh6/X0ao3UpZBEz0rs3DJoFzkBGkT0CKnXO5sWWhd8BSCs7i+q4Y/Uv4CsXkIQDtDdS89wWq9Uq7k8t/wIqRjeARGntOYddBSz2T5+7mbiKWeaINl3KRHgyvb9F5QgzZ2TkkKycondVSkZ5HQ8ZF01eMAmHVc/XWomwQOtq4le8VcDxUsb4DsUsrpqktCZyYVG7qLSyYixPUtUSjOgSjKHjytY0oM+ZpaShAsgwnvYg0v1R732mP/ExluxvNDsIyyOAQuPMGx0YeIXjkznPCtP1OCSLNN3lggrO5C2nNzGaBE+KYEsVakkCLYsw0xBVL8T0lMkgvLIIrl5yRaHR1gyaqFVpcAHof/lJ/+ePR2yRsWyb+v1E4UETBa9ZTguFhp+nvh++vA/zBwWLikk6rr2xsBC3w+mdlLOJcCVTB9VON1gvcrWw7AaNvT1FopPO2sUCGb3A8UAkJfmQr7ICn6iPqygt1paqUqgj/meDsWCPbce4MPH5DkQ1Q1etVsDs4IF1DZ7kseI8tegRx5OtVlFyvPqw7bHmRccWaY+jmzhyixRDlywc86RztqLzjzrtHBsrQNyrWYKNDM9xQpIm4kzItdiEpGkZ1Dl+12IsnNlGvNGHlyNqFtnsXOVnx3Wh/8qlc68C5QbC1+fGtxwayVql8dotiP5FSgIzbLknC6SaSHyFZ/J8gdAF8ewp8nwb34nsyb27D1hl8MH2g7137xcUThFeVCG1LgVk8Ist+XBBXVJRid+DSYEJNYkYHKlJgi7jrbLgjJJYph9Jh5YPLXvzJM0mFreZyEOeziYUMeuY2R2Zogoh3o73vtmCj+Gl+UUioAaCqweNLhOJn2OFKzlP1oWLzdKujnRwCeTUGKwK7EGygsZyxZ2WS7nLMYKCBhE94/PB3yj0Ue0XPZs2b8ZO7WXZ9plr0A1RbW5UelZcgEKz5TSvSvSC1zBoJzSnPf5UDUKv87rvdaw1/JRqUVMtRjn+5sw3WuFVJWELERxKmjAVWofpkre2Rh5jMWxvTEuWRSV0EhhKqJhPm1VC3K4wp06Lw4dXvOsJE5PnOMSJWTdcUATN2qQ/FPTNaFQujiALUSJeUA3WvY2TnU7LgZS+AVZa6Xmp0oeEgZmAxO/FSMRBzyQLLIpewHh78Osv+x/tMI1p8LvdZ394jIJx936JivRsDz79CJAKYQUdqcmaFiX8yvycBkop7FtorqOXDwtlHZumsmcSHedN9BcP5ot0CH5Y4UBmmk3C0SBQZ8R6bZ25GA9Mr0V3PUmr5c1DWXROZGPIoXFy7wcWLGbdirRH9iRHou6IYcuqOWIMs+mNBGeD1ohupIhD8c10eI2RzJFFX4ywzK4tXqTUi3TF6IWTv3JNkXC5UVOM0Pir0RO1EB2klkj5RqsjUtYcG9JU9nf98O/64T71Q/4Y+bt2OGrtEO/956obUq3jP5VuSKh4EJqh9jA4SL0QPRErPrl2EOohwfcSbHc83/IJwZgj3Qmo6Z8WAXvTCZwVrkK6VNwidqCjZ6VwfsVFHIvrYXqKcop/e5iMUFCECKv7sOr5Zyz+9Y64CIS2PEe8nWltBgGW4g/xZl4kWcHRnl36oSYIg30tRYNyu1ikSnXdCmh1ClS+0ApgGB/JBtu4Ygekb6ZxZkD2ilqCbifCwedw6JLgol1zjbQ/JWUcMeKjUAA68nn0SLxwSler1WgcgiRuQ/LH1AEueBuvQBIRoO5en32c42MQ8MP05zwbShcEWlAKWgSkFO0PhxjhttrzIXqzrkIaaXXmLHMoqrJWRTZoyOxpxVgzluDA0uWl0E2AhepcDBzWw4g1JbB4KMbd5DPj1g5+A/Xrm8+++jN5CnVH6aOR7kQXAUUoOaJhklgX1/4Q98857gF3AUH8jh35rVggqnShzA9U0nUVkeSnXUDvQX8MRLQHn233/+UOzpRPoAf60+2gOE8E1GlyPvBnCc+TupuO6TMDOzJUMMnAtyIdxfsSftk9330JC3DzfSl+Mb7A7Vnbt9bWoP1jVGyAxotxUCg0AfOgKLEFnlYWdFHyLieLohOhiKwO5KJfMh4HNBZBiju4KkhlJXKAOIC1IclNy7eziYU4SM63jVuRnn6aHsoxAvg7nAo8z/B0BLQmFj4VaIi8tjqfaycKOl6zjAI3cScjUmjiCmlT0HaUJMx3D/6noR17Krf/8U7/83vPvnmyd/fe4NNHkQ2B34oFLX4rlr2WFz3cx7xkWHbiNgVdPxE56uwnBqOj2BCkK+mMrjZZrz7RjkE/GsEkXfQ8nPPKE/VOufMo7RLVpZiZTdMkXBmKJf2Vltfb2PSmEBEJJvQUqhEmbWBiwmA2bEH09mDieOI1Ws8ZLlnZPOyLuhjZAn0saNqLXCvaLtTGdF8aTBwxc/LHU6ROz6U0dLnnQJMlnHD6YZGhk72CFQJt0bRGGKRUCEzhbyuheyp6eTfXSYFlCNc7TQRhtS8ozJni1jo+vJZHcxT4mfQ1goAM75WVUD66+K6ylP/0ZlLj6AH3u58Pdp7iSjH3H/c//KygrxNE7fskBIwNEhvVNAmz/Gw51FXBYJbFWCb5CMwhapySD9udWEhiLWeRdK8AOV5fI3TkDtqhcg2DhkBAmfsY1dz04NZeycixLrweDsuxtO8wHMu6yhz7qz8lNY6Uk39+mINdBVWWBmdXQL0UjZvKxKzh82PiF81QD8/aR/Oy9tG/UdYWRDp/zlBplHYKCGcjWXtNF/Wo48bQPsY2Dk771hp4AZz2vY5hPIXFkG4fhJYfYjZD3xJYTbgVmi4v6j0pfpkeD4DfidD3IWZidFW65FtusAr9Klxdhc3wZKvlbeA9VED7vpC5ewBD9LJXEWc1jXdaluMWyiBZj9PKMzP5oGsnaLAaUhA3dzo19KbXAr4IVrxrKGw0ujyz5yJx6rB+KtrFMJnmxr9fwuD5MrAVWTa0e6AbnibpZklCjAP1hRd4wA8JftFEYWZgTkqj/R19Zoq0oHUNDs8sRujyweF1Rr0qw8AcWWm4BUTPbXJ8KC2n1owjHk+rvtc+S85m8YzDZ8X5VY53TKhQM23iKInygyEWw/IiqCHU2KAvIh0yAzIrXte1kQMMk3cNhi+hHxx37VTLgW54ATbNC0KDZgLohydXcTwqXfFqE3f+r+AEHb+KU/aOsn9tOHa4DsbBhGFkgR40KibCVIyM0emDG5fws3j7o64OBmnoo0jXibFfAHXQALVSGdTKIJUHMmkMveS8diy8hfuy5dvC23Zz7NX2scQ59cZhNLxoGva9jYssEzGXgTjumGAm9r2Nyjr27FQC0rggz/4K9ePknfwVxadjnlvn2vG9jVeJvS11ZmZeYVPjfooD51c/B/33/3lw/7Eyj1y1I+s8tCqDNrZkOXqXKfKs9TrXlxX68KvPQKcsYmykKfMWtJxsqxSZDInHHHfLyCC4bUHsyWyMPrb4zfGf2g66IRYmpqSfLSQhCtM18ecghOgGUqiLP8v1SaihViathI85AIfiHwff6M7sBJco+0PT73kolaIUyQySyiiKN1re1hJXvMIcSwnNCLxxipBOBsVdRRazmnIQQRZJQHuluqpoO3FvkjT2fH4xlPaXcbIKaqwpGJBX2OFswKxz4tbipKQc2slW6yU5qC9LQJ8SzBdtBnHYBAiDttVqsedrDL2NEaPbg68ey3GiUt+E/SgHwxkC4YyRRmMJ5n30WK2vNEpKrzYkysYho6nJ1Rp3RdKjBFc1saBplfWM0UCyolJOgS41N3RMyK6G4Wj5kxsyJ2/yPeU4iMe3nj3Z3fvsE13b58WHNCaQ3K4CjdAn5KLXLz7GbbTsrOMubzUCzBRflIO3VW2+N5b3LI3AkcOMdBcDJRKZxjpFg8ixTlEksTSoQcHIqGiM6pDXx30RHH6C7mz6gk0qwqSxXFTpr0FyNFG1sREfbfyYOWWH0FUWHt/8fvD+HW3L5yU6Ip1MzLxR15GLfzVRHgXQjliliEbMSHX0xBh+lVgdQAl6xi9OqO2eF+W1ZfMkkRc4/0RKy9ZShSWK7HzNC5ERQ1/RZvDHncH7d8De3R3wbHdncP8ejZfpf/AJYNGGjwd3n4K9u1/2b9/q335YLaRWwosLYyRKZUOEqUZy8bJXX6x5lSvFrvuDn7Y5kVifJEG4aKdEgSno5MlUj0QXBWs6RYzYLpkG9RMONlnky2NI8e1Z5EBeQYCvQ/ztjgvuFXT0jL04bUq8luI7kLbL/9/eu3XHcV3nou/4FcUaHEq31WiSsnccgxcMiqQs2pLICJCTsyGYKHQXgAobXXBXNSEE7DMoCfJgRHpHikSTUkAZ2qYly4ceoSTKok64z4PzT/SIbozkJ5wx57rUusxVlwbkSxI/WETXusw1122uefmmeoyWrZNtf62GeExqKjPAGTvu/NxTb236wcurHXBswLeb3t5726OtT0WA70vnDzgugB3gz2QwwTwYtKZA1JJ5EbSTzo0+bkF12/Fy7TANok6S50DDSqimAv6TOxxotd9Jo0ne83GjS55QOs/bipVQu1TdbMv6+pgethSNPPzBJpInlgSjG+XhXyYNQxYsZ6VjYMIphUQ6ftqFCUKcU/2CZyTfKZUZ57lxqQs24L1JDGzh8KZWBJLec1XCAhUXuPvgnzJNA9k99/aYw+gH1vI8DwxseOrsDkxfcD4+9ShVYkcZJ+MlV56jOunXPJbD6B/N+1NOBVyveqKPg3P9tPqdzvqFB6XerzeVfeXOmnmEKVAs/F2nrwS7tHPuC3GDiJcVOARZuMg5jpTS2bJhzjFE6L0Qt83Rmm2ZxqiOYj3QTdvizOUd8/3S8LjBycBU46WJKFCeFbLaa4ItVDtEH37m69R9HbmSX0xTP05xnFutB/OJbx+OWvG1TtAKV+KObk+pQpdFE55bH7wx3PmV3lUFO4XjaaOvdkfscIoWVFaIkEGdy1sXJQtJFnv/j0pzznasOJzL4UY7Xu8WjwfEKUa0zOJ5rovwb8T5VzD4Ugw4kHPJZV/ScncepED8HUMg/v2XPLqZPXa/kaBZLhE/DXrTLCKW/0QHbMJsloIGkgGgmgJWzVs1oehcNYwxhzRNQrIWQLHmIo+pj8oc0FUbbHVgwk20VqK1ccEmQK52o1msRGukLinTJ/EZm0QaVBkcfvAtZIyO4TVQiVY08TuJtWJ5Cqi1w3s6tmtCGTgK5FJu8IMI9GY4kcyzcGwmEOmZ7L5y8Ta9spibXg7uJm3e0Ec6Ydg2bKomXFo6NTaeMkuUZBefejulB6WM4tHnruNfjIo89nndfEuDbIEK9+EtZK/TAgLIRGRGhj2rC3UF0todnRy3LWHC1WgBvoophxQArBgD2s+tTOqQiT6cKk6UHlj2JrLM1avVmpK5nOyV6XAQNd5Pvl8KgruCOGLoK93gNNahl7PQJlxXnlbnkK305cwmwJpp1s3nJCfMm5m6+xjKHWZmLXYp+mjPgkbO5BanE3PKAcwH+JuCnWKtl7xgWWHfrm4Ylv7ttn/cKiKiggT44s727qcPiLbGgHJimg8NLtm1UhTcOs/MJ+DeBqxpXU0nRFo9lDNak0hOnp5xpAS8EYVDaMG81ADXrGx4vyPzZW6agQLcNMqIl5NaoIRpzCnvVpYJLLmXIjhX/s2TgQHsyJKA86XgyiOwpWFqCPlScVnJuIx0bC5HHuJ2yjtG0o8KZhmVNmh6hzdV+XqwQNaayguYLhbEFeNIlkNmn9PgSJdKdxskrT+UNBskrUxQABDR49bn/Mn0v/7p297ozr3hR1ujB78eXd/2iR5yxFU9PQUTeRgdpD/WH44z0FfGGkwfdNwuUMicd7zhaw+HHz2mmYNtVOQOJ0VvRxTRzaJJyxDT6HLQYt3dYu4F6pbXC2R2anhOSbiU6O65QV9Ly7EelXEj//yQ9NObmZS3Kq9aSu7yyDyKufJXGRmspBxGyWIC7NCSxUrLY06ZzJTLZqwkWtqiMuQyLzfjbjkZrZycpuljPZFO76A0sP+j6Y0+eHt0+w1vdPfx6ONr3t7Nu6Pbbxy0WwKYk/8m7l1+Ll6+CJG5YMziFiy+k/XUPaqVOoOv64VoiNFn6cjL33r5W7W5H39r/sk6/PPIspE47vAxxc5U1NilS7W5H1+af7J+6dL+Glqozf14Yf7J+kJ+MxSgIGcU3yc1qaLGgHDW2GrQuwyWiAYHuez3WuHFIF0xQB4doTKiNmew7iC4EvTC9sVOfzlSz89gba25hj8mIJiz7zU/CXtXolbYjdcnV4NusBz6dSoFoa45yvINqp1NN9non+fEne+mMZUd19CRq4ArWYSvGOEkazNsqzbxK3HU1romerb0iyr3tWHpP2VTAXoZ36dcKNQXh2ZJXY8uR89F3csXgzQNeyr7j9QO1adfnnt5rjb346svz88/ialBr9bmfox/1Kfn548sK6hurX4vAbWVSEMJv2FuUV5mfSXqhMoE6cPFksRBb9DXDF8JWzXDRaWOr0UIK7dmC5YENt0UCCuMTMr2YAMoFF130j5Oa0DIE8gpHjC/mqTjdNWU7eII8lOtKWN251srmTq+vFqGyTa4Ek/aszv31DxPl2sp8Tk6LnHZs5rfnp/mVScMNeRymD4TdUKoWcu6t3voRN3L5fRFfqBBd0NFtyooAgtrN+hMQjHfrLbSC5cAQUTSZRYQuH2soNa0u5JbXFfYaFYaQ4MUJBvdVjEkeHEQfznHZ+xyPYhSPPjX497lZC1o0W64oNzswrGQv6UyHubk3cxOT7yaGgXyeyvtdVzQ+cq6ZIVXwzTISUlZQvlMnkswo1opfvRO5J2cnSBh4etW3l9e/QQ/gpg6g77znKdj6ZOxwqmonoj82C46nBypUHVXU84tzX/+iSe00StfaUYYrwqfTDuNrOBjPddNexva+6gTLxfIUpAlfKNiGCjWyQmLgI012YmXJ7Gglmg6XoYDCbPR214BEBwfdZfLO67yCoTvqiSBF7H8VoGKb8Z0Di0XKPYldehUZdZ1H74q+5Ragg3aaztIQ/uKEo/sCnBm4u3KnSxliJH7JW0NEt0ZCdNEBeuF/pobvfbb0c62XTwJ09Np2osW+ylgL/eigGtfG44W7HG6Qcxy76oy91Sp9BbUc6XSM8W0EZBvEjYls1HrcpjywwMF3OxRUhDo4++9e3P4i/u7Xz4a3X0E6RqGN+5BdoDhh9vDd7Yh0mf4T/c4l/duPfRGv3w82no0ev/dpk+aSyljhTkSPkMZEHF3KeqtMroBmc6n7SBkJVHluKuCGbOFI5l2lzdeahFqjqArBz7WetRtx+uwYmEzx/20loephMYe3lOUnIm7XdSE1knOFQ8drV5+bq0ilZZz+AI7qZADg4b37aNHj461HMTQ8qAJ4V7bdIh/2jOZ2Ay17L5swKlLSZx4CYI4DM8HPDMAw8c700/SeJX97bc6KZ6D2TEIUGub3mJ/cbETJiznsTcw3Z0HXgvfqrWw17MfksZWXKBONm90497ezV9PeYc3sY3p5mqYJMFyiIIj/DJYaHh/5eK/yV0iNnMwQTl+U1eRpSFkrDOh4iHOg9AepJhoplquMMg0U0I8UR2o3Toq0WImtcM13GJFhHLF9PKCInolRQJTJQabFynLWaOqD7GQrlOD18ls3I7PIBuej9tBB/AbhY3kPMLpocKi4Sm/z6RB2ocoJp+H7Pm6OLjPi8d54QhyUURFag0lmLrI7Z2r7Ve7rRoFrKuyYhpTmE9DFj3UX9kvMHa7g1mkzU6C8+3841grWow7yvANPSCDJfyrwT/Pc9RDEYPPf5IJ15HYOrJK78+NFoooqWm4WmdQimncjmG+2bkHybyAdQkWwW5KYwVmp2cvXOqFycrpTgfaAoKTPLhDZsf+URSuszkHkvy6cNmO2/HTcdBru1pAjPMc9252leQtALbmJ3IexuaFk3/+woTGnbCJH2v+3Oj2G8P7D/fubO2998m8t/v5F6P3P/Fm48mzMTc7eKPbD3cfPeBncgMsnaMPfsU/CnDpna299+5A8ins0jSSDJQ9uhi0LgMIYrl3kihNSOirsHcmRQEdqWeV7dEyPWBRovlunIasD+bHAfM+yZphP/sHn0YH+5Qga17p9Dkr3ynKnoMtFybP+frO297o9et8+ke/e3f3wTWNkFYnTiRUQclnmFLHRRgW8e3iLjFOS+rC0r001Iq69WQxbm+UXG1xe4OgUZ16KGLmNoJTDRNOlQ0hVKq4uluKe6s8Y+Nxq7PnCuIV1TwGSg0tkGJh78aD0eN3vBOLHpJw0uy8F/6kH4GV5hQL5TxxZPHUgk2LcGF3E8O8YupqVXTmvMA9up01uRMHr6nUsbxe1W8mniAbJhuDN7p13du79WuvNrr7ePjgDlvpdV9lFeERrTTPiYFwRbwNMw/5Jnh61TDOvcFi5uvK5Yih+vrF2OzErQAwHVbXgp4MIWTR9nrJhudfjlH07vZXw17UykTvrHsTizjPib4ky2lveE/evhApEDbXUAVP+fFAdCLEdkaGVGA0ACkqGsqPCV5582bks0gc+vsvPQeB+tSz/o/ne9a7ZC0gbBqHxjIXFw3ZuXZiddmoDw71EJAnmdyrDa1FA6mHDbHSkaPWqXjm8KpVDh21inHq3NqBt16ZY2fv1tbo+h3r2OFtn2cRrk5yYC0EvTAwSDpvx456/uizO8OPMJ0yCDfvfwIqIRYHChmSuOaH4KMID1ZG29A60uetjd7hFSZNVqg4Y4hlW2G6ZHnz8Bx+fHP4y5swXzV2gNatformQU/3KipIjSz8kkar4SQehr45bpEhVRDYyJowXCTwzKjEXaVKRf6ymlU4rNSwlHM3tkcfgNz16t7r20Q3FS/Y2QtnL1yamT09+9LMuRl5KST85XzKMluMcSUY1wFrW09FQB7IACPBykatuDvw5J/czdeqrhzTWScs74f5QFLS0Spcc5/EA2IRiKD7bK4aWmtixaGYqB3ZWL+hHQ6NbBU31F4cYK1lxFMCo5WQUDOEVs+B7VZWcHeAt6mSO+tsUrOrlEJu80j0s5KU0fBmTroUcDMvF9uMePfoWEU1dWwNpSUxq+w1yQuzZ0oD10vDy+CLtIetukKxtjgqBSeU1SaybrGqhlAAzx8C9UW2wxSZhnlIBs8D/NezmPRLfb5LKrlePENN91TwSl7RO0kZmKiw+6QVrIHFA4lWdSJQuKb5EVi+AnUwRTvi+LWFEbUumwQrb0u3qQxLUXugXJVsZp3FMy4p3GG+GDgeOcOSQfK8ktNpt+6Yy0KcPsNGaC4gHSnpvKUJ1HKf6CIyDkaTjLl76dWrRpITHg+kiGjM2YD5NJk6LM2UxwRKVWTLM9hpfSzFrT6BSmGo0wi0M7ftJgc4EY8Vb3Tv7a+vfaTYo2x9MXfyaaOys6ZyXpcuGY8UkUj8oF2BAvTcwUBtYjWoJ1OXa/8uX28DSHSPp+fwV4/5Abr38+ujN7/giIgLAK+SV8CaJ/NkGF8fm68PVW1R6vlfxgZlkEevD8L6VOkGUtSoYjcXm1+BU8bLtl6w9lFVrW1WrQgaPOuEGQdrAOPhQGEGDabB37R0RWCVkDlci3UCXPuRecumQXI54WBRNcVAcPWqNzdfL6uKYRoW4YmSq4xBrY1Rsq4QJPg7GySX0Y8xuZzMHZ3Xz7dvWu/9zaq9ceKYgCnU3v+5tN4LoPU+vClW6IBrv4e/+WT44d2FP0/ttxpfuhH3S6IpsrLU80JZBKyQNlEATnYx6IYle+Gli/qJknRyLeiGusYBdXrlO8vKF3THCqodcm5wNguqG0qT2lYyZH5W+7+KsF9KyB9fCv+TFKn5Ax7nCtyIw/YsOnsgFCWPTPG4vEsI1MwzRI+tUu+7rOSaiDzxjqyk6VoyPfXykZePzP345eTEqVp9/skjy5GChhqmXry0lMCwRaCJp2NkskiSeIl5muBfECPJu7GEbTtChLVfd3g9uxydsTfmq8waaKhBGBZoIsc07cF9xmIcjs7LsK4jc83G8UPT808ePtLQWWYGNOQHMWjuqUpAQr/XIT7qB7KjDF9ynn9psRNgyINVpodqQ78bg/wU9rxu3AuXwl5P3n+lnNvtEae9IOowF2TJMcbwfq8jvNYJH0terfKEinqmMUYsP3XVPJmRxAihHlhADa99gq1O4Wq/z6UmV9dAV8jjUc6ftAwiIG/LLhVolw3/7qU8zTK/b0CItby7K2apJzLOG6nmNcNJXstpL9bdHXkdo/nstPr62ru+OWJ+EzKrHm/Axi7FstSkcP+cWS7rM6XEGt8hbdOxqbKbUNk3xB/sHeFJkHf9HcG0Kyn+cgp/gpcSV34LZqAqhX524GCFh1OmsukE6fPBmua/JR23VE6oEwZPa7gUa9avZ3EZmxq86m90l5+UuTQEJYTsI+VKEy7SgN1A2s7EfVzJgtNoaNZ4zS0m6J/djrshTK1xcJUFOjfOBQGCXUL+FRDpdmXjDcPTex3eZANilCJM9++/9Ib/8mj03tbwlze9w5vK8OHzwnGbf1oiOtadMb+H1F5ouD50mSjPE+nEUU5MZ2BgVHXTgPnOp8MP7w7f2mavOtTr3P6ponaykZotHmDDpZWEfEVxu5tYUhSLFqu9JKWYbj8mF+jVA6cbWxHi5FDPGfQnnfZ8+aMPOjpfNcPtI7gpP8DJItUOdDLNoN5J07QJx6OwXp4SJkPx/FD2cN3d6PlW7gSYN21mMISKJog+fphG2ya7G2/f8N11uXJD1GI4UPww54STTjUY+VWJYjOkyzUHPJzLqqoPE+lr98OzQMi0twBZ3G5t85NHfBiAvpf9IAO+qJWhWVyBL0yZTUu37MFUYf2ZnvSugXNPeqsqMXCGekpsR+X5H3WXGx73g6dKOt+wrhgaQjpwgTaat3TRbe1R0PfUIbioqpY8IoOyekOfFZ5fln4iU8e4bmm8X9QR/0nfL6P3Ho9+839Gt98abW17e+/dGt19BAapzNKBXjOWFxHBj/FvnAw1qxcVOXMYbFEqlWOMsVVM7UdNabChrdumsSHUB9jZ8Ug3qpYfgOf6mIStuNvWBS6V0EKPH+v9pNSzls7rr462HnGPM0eHT5d2XXbMhmjEmAyRDwiuqUxE0iga3X1oiEq5zBeOWtl4G8oYrIlf7kUVXtJQuuAhDUV8o0aSbnQgEU9vOerOxixt9VNrr9hZgDR3LkLKyLynDDckjalc2lDucuKzQSJnG3EowIOs5nOvsIZKY73hLM7mcnT3sW9OuAhbd9flT4TRneujnVtUE+xqL2yBqNqKV9cwfPB0mpO/qJIvVIE/lL23dbcoVSuytvF0dUk8q1bFNcqoaT5WcON5w8+/GL12n65R1XmjKJS0G1yJlhFIvNWJ1hbhWd5c70VMl1abs05w+hxxuWq/3H2561PJf1QHDm5uk463bPi5zgHVIkxZg2PY8+kgUYlr3x1j2WTVqi4bpaZ5kfzzW8PPH3ki0AGjteiK46we0hGDLR4RyshcAGqa0HY8h3dhO0rH4F1WbRyvP6MFk4fX74x2bu3duqPzTqlQTWw3nKbUtF2z7D1uxiUwVjLJmXlRqBUaEhYxU45mrjvtuoPfpveiPEgayrJoKMO07nhFNtWFO0sEaOCNZvo5DrQIZfV5Yj5JqPhglR0psiFYSsPeDEST8gDhP2wEMCPoIOOAzRbFOHFDsrRn/OFHPQ0vLP4dujknSbTc5VXVSlevepsD4gDGgeKhXhADfEDxv3pf7mjbfcb+Dib2FfO7v3jfMrG+ygJTV7KxiLgDoCxQU6a04PH+jQUD88fBAccEg7kaTh+mW1Rc5f68naaIWOH/XE5T2n4GNSB3olJ/5p5U6PoJn/Ev/8/doeqbiCb+A8aD/HeAwvgBCv8Z/ZcqukBwQaDkAx2v6jEcIJCMc50Kdg5eo4wbBA7uXDU1Hq9T0g0Chy38BhlhDdGE7QgBpd2qdGLD4H5zqc/FmZCrXuc3Lq1ZH0uRXEKZrEy6UtJ3t1HK/DKOOnE8leJB6AtTWk/otPk5dYSm6o09/v2GcTHD2pR6gZ+O7t70643cdkroG/N0jmmOrrGEvjF16xnzdI2pU8dIoOWowZtt8/VKJ3cYU9ezP33PvnQ+mqNG7htP6SIXj84kR0Jb3n6w+9kDsB4wWmyzgam6w2dSLiHjqKly1VW5aqvUflRRD6sBZYQcT5F1MMqssRRaVZVayuMM1wS/lVTxw6FrKtQv0UZN2mexUlz/2HAX+4K8sGAvTBwaFqfo6qoqnIUVyyii8Yl7cjzMin3gVoyHXTE+fkUuhoV1z1C9VUKxqIBkoRfV5kj40KCWjOJbCeyLfeFfjIuBsR8cjCIsDBUEY59AGNXAMA4aI4kCxTgAYIxS4BhOcbIcNIZ5+1WEyKAErSrAGPtErdgPckUl9IoK8AD2Zco0nY7bdGxcjP1jYxSEsO9cG33wK7roOEJbUdQ/fyHvI9y/TMh+mTHbYftFlnWmss8sPAm3ztBiK3Q6RQX3k6X51TFlRf7T2fJwj00RqACFQq8QFy31vO1bmGsakev8oAwiDqFdNfsb2mi8Z5kKeoCeeUxA1kAK9uVmwM0k2OwYzgaVAAQqbtMiZwYG7j3GYaNWLHfctCGHpBrnpjVB4ta7Co994nD4BA7wbq8URMHQTRmju3e8BeYfDy/czL+T5wi4M7qxvfvZDltLu1/dnAbXF9EIuByilDdYqNOg99q4xsaF51DwABri2B9j7rZNr9lssuOL48BLAMr97UHGvbw9mPumLzh5xtq/pQHoCXpc01gagN54Q6vtNbwc7KmivAwU8kfDe+oo6aRBOWNwaHkb3gMMuFeicP35uI37vhOkYSJchOFj0OlAFs+zWf5XPbktlmm3n4l7qxfWQjW/HqrR11nHiZZ2SIf3lTbiSjD7lLHYgNovgTBdqUvLfGz0l5mRaWzpSp3ZlmOqN2lBNoc2yxR8hV0ye3I2vFnTqkz1KqzLZjU6d9DCf/zinbve4U0NMWZ6mkKMGeiJUxdsA6S45IoGpuc9MhPzShsabYymxiyM0qWs0rZZWrG/Iq/qx11lnDjY+/SNKgXkQ0+LzGmqgBpgd0wFCy9YPcFPkAbT/NZIpptzotN55s+koQeyAMUzQa+kAUip4Ej7hMk1mAOxHn+p9Vik9bC7ZBqPsn3y3E9EC8aCmXn2wouz3tlzM2dePH9x9vyFFyhqZwvcQnSTp1rJ6E6dt2ayAid7ZkSZUPL7KXDOUOpSu6DYnD8D5TylOX9eLenXrALcqFX37akVigqFcQ1tXHUdVka2OavhcmjDVS2j2giNDxAGLvJ4CqnL6MFOHydCMnJWFCthx2EkxYuKtriWDWAW26BeFIfsq5Oz978ej74y7A8HFKtkAn1rvLXZoy+GhlrBHpKyfDjKBGtFpvfRADe6CUg8bbY0je0hPoNIN21tlunm5VhV/ppN6lFROQ233W1yeA+NSLA3U53YSzIrVm1VZvX2tzAVysdZolZ12ySzvfvFb0c/f+gNP7s+uv3bnBWbtVUtJEuvZxAwZ0xNg56Y/OgKku3Clc3kQMMgqMTqzyoQG4DrgaOycFxZ+RL3IJb1rYqG6nyGySsvxOscQhsebfotlXIzi5lhQLruCA27iwdZ77pEBYLdbBx3FoOq0rlSs1BYZsV0GR2eXCwhRVKxZ6VmUc9QdJKZBhK9e/bKO1hZWm2zFGVSdW9Xpx8S/uiL7d0vH/M3gj6ioNM52OHIBscYS1bXNRAG90ENBCBryo5E0ejxPLu96hPg6WnpoA3fbi813pP6ELzRzq3hzn1vdH0bAqmHn1/b/ez/+MSKJdMrq1OvpacrrCkZXa1aNi6tnrqpyXpKw1pF1bO4mhLDcDGmpkrNWMRscoTelEr0SGtRNa2MFp7BdUR0hAb+xiZKpGw9Cbnpn1N/qmmNW2BDvBRcXDYSkQ4bZID0tdune2FQkbm8Vg5/g3Yb1zw6Zpg9ItRT5R6hVokewdHA6lE4MZARTKzbF6PWisj6yItryl/Z3bQereSorZ+FnGG6FcpMV0jAhBsVIAMZPxZy0rFM2CnNp0p5zwhOM2WokflWY7J0+pCytGRy1E1SUMfGSx442cKzA4bOO1RFadmTmXOm1CiJlKLA5dY4N39WscySbhHXPtNAn263D1iLpjdbdKCZlnuyDdfFKSz4RgKKAx+T1milESkWeaIl17gEYrg50+Q9ZDBLu4uK6mrkWDXhvFSr8RNNBKzQJYRLU06R0zI2RZm4pThOK+vFWaWiGWGlfKK758KldKwuoWK5bicBLpDq+0VAHByrc6xZsnfENbQulwOWjg9kawRF2+LfH9/wlINW3yWZc/cLcXrAhgG91bFONKMJ18ZnjuDDNx7tvfkocwQ3152xnTTDobpCyC2vU6Lteb6b1GpZr1r7RBnsksqck6XVlsFe9mflse4so0jkzjKLmR7E/siPI+d3NhDLpkjFzBUEzVkhbTqfhTGWkISLQoPId5Ii+KTx8nInNBY2C4M2ZLfM0HsyM/Vaa594/e6rn6DToTsxn6vuXlaidjvsuno5VLYXeg/y8RpW7pPCzm15CUyjImJ0Y2d0fdv+OuX5ozv3hh/cGb61DQUsr8gOvrsqzEvWb42Ou7eeZs703NPenPNbxabmnV+mvDn7Y51gFED4ai9Guk2G4uvszoL33cwdogjOS/odcxFQ/+N2pMJyBYvIm/YMuOEpTwMVLuzARCYuRVEV6otHoKMgTxkjKtVJvXicRggX5QLFZw/2/dF6wXwrkZqs2vHc4oP83nlLVY4Lew8yvjFc9UnGVfyjsOqUUtibVNtxD2owUcRl4GjHdNHJRW20HadKyFryMAfpdqJo2i2wR6uGkL+k6tInm3Cf+Uz++uDt0daniJ6nep5QQMOuMEQd87FafFQHsbAnxuGlzUe1d2jYyT5fV/lCWXV8Sq6JTrwMmSZgeZgrAnsgJSA5RBwAv0gQISd3YXTi5Yb7gtNVTgX3S51kuTVnMIS6pqIx5LTTTHysGQqhTK1YUWQ5pHjK0XIX1yC6V+3C3p2t0QcAh7a9++BVMJZBgE+QnuXHcK0+WDA2t9KpOYmKp6HFUqY5lvov4XZolTvqZj3FWfRvYo6I9bIwEjprJSqCvt0R8+GHEieB5K8Lb8Kg0WyL4TnUS4JOEABsfLzksoSm9JGo+TO1L67MmWYhcpmZU29ouJR0m9bkaS8Py/6QvWa5A/eEvoQ2HcKu4W1aylgwmKCNdAdIFLwkxqZIeW3skyRbxpioIK5N0KKHH7i+TUm33nHnQq6l/Q5c9SYmXOjliSRi9Xzfuna1w9tFsalzPlC6CZ/xAyNc37oVyM6BidRTzNhLTaNdusc5w8EKvPVpydBpT9FCxCbKPBnMa4soQgVyGOK/zujCCLQiNb9iPBdBac2mJVrmhYgEbWGmdesCGi4gQKCmGvPUhUoUyl/uzsPeEQdCLPtSx5DDjjz28lNeAKhvHr51Z3RbRbOleFgtbkXH7aOpmRMeFojp5wlQP41ITywkDHfx6ZnHTkrNexGH9Fga+oqZNviIcUJIJZhFP77mDX/zrzo4cDE7l6Ju0OlQu8K1QUna+BotaCR/6+rWOkdE0ESOKeFgTmtNpqSST6+toVYtWQta9kQheCngzCNKdNk3F726fMeqQ2bnTa1xF+eBsrlZlDFCa80N2OZuikCWI6XzTEJn8G7WRxXuTX8aUScB+TrIW09uuLiJnBcS+Tqqa3FjxPFqHcyDiYmJI0dgiPv6H7Tx1F82vb03bo7uPhw+etfbu31v+LN3D6TtLPKNKSCeRTvUs+lqp9aKO/3VrgE5HPfS86hRO6nF8V0JQbZmcLn4XV8GvT74w52yb6E+xE9hP+brTSwO9hXecLYrhSTpxb7mb5dReeqk8eKeVsmdkwV1ZfoUzyxnehoG7WWEu+A9Kv5DC1r9E4AC4qHO4yRTHzHzHvoLTi5CM77NjMO0blb01myLl4tTfcksSHl61WnP//qnb/s55gj/65++40+U0PQ6yFVXA9eRnvKO5RC0kKvJzWflWi+Ke1G6QXDTJjdbFU96xwb5vR6Bbt2NLuQx0C9AajYbX5hQKxPBkGdg9CHmcZxX/LP4zmCQPDDz4SuQ0zboaFoVrYnmWj9ZqRHqTUizKuIjzaQVg6xLRSEr+57QVp84cCG/FWupOjGijQKCuHkhY98JQ9XJV83hTb1bFlDg+fWBb+b/CibZwCYvhxtQkV0Ep9O0Fy3207CWHUZW5V6wvAzy1EkfnjvZx1PlTgb+4iAWsrMKi5mjF6kgXTnIGb5O3V74Yj1O0FsGTz16BdtDI67sjO5emER/H06u4KVq7xLkPy9Tmf+ewG4+6Q/f2R5+cGf3y0cgQ9++743+9f7wF4+94db14Vdb3ujDB6Od63rlU+aWPHEkXWF/LRzsNf7dpiTno/uj1+6P7j4cfXT9gG/yxajbPoOcehG5WUthYYp9iH/IkTZ/0g97GwwnJe5Bamx9Q84ZszJP+aJKsCk2tbZcyH7PEcJkf6txPwkJhXWO0KnLmWs9/O/ZcCnod1IXOCIrm6Tx2sVevBYsY3hZzWVOldDKOTZwPkRgV0LIudqLgrHzhwCXldMfW+zcCpTTM06oPo/5RuyFVtyZE6ed2GpnZmaabLvV2Paad19y+Xzip23Y6RSzCyX6BJyWV3xXq+SjQhqJNC45i1296h3K6KKtvDm2cUr7VWAElzFjvfRvc/jAzRedKOymf3u8sKm/idpgdHazNX+McgUuh+nTcb8L6RvPYN8vhq20lu9w0FyHzh00yvlUPcydzfm4AyAH6kSV9aU7lLGMZ61+L4l7OSzxYZGzHedXaLefhD0BwuduuwvJkh2tyvMYz7TnwYLmbEha8SovTQlqlAYFHjqyD7HccktP8rWb42HC4wLD9aJVCf97PkhXmqtRt9i/5thTR482Ckux9oJXyvnrfPsvG6XKYas92Bnl/YCyjVm6ypNswg7KC2hiXB8h7fDkC3+9xGQuHN4U0z5Ye2Uhp4ckTAFQLeGvfKyS5PvVXSY0AdKRDhIh8Z4rHcf6ZnxprZa3p6zDjBvAc8kuONOKpmKss43pFCu2WupkK99yoQsCLeNBJb9RcGDxc3N/DB2TwP5aGfJeWhuLONCiz/Ct4ZJRPTrcr+SCL6H5HGti8iel8OauSk3uLOTNQGHCLAMAduB4QMU9QAnTXlCqmAtamdO9XrDRXOrFqzVCFoc3lZ+uzBnqhXmZKxJAwVB9ELZ/CE+MbN/xLrLnFcfGOmWpVIg4V2gSryYt4Yqlrle185k43iQe7HXqyCz76KLtx5YGRbCAj4q/pjIVsQkg7RngX1lwIzYX6ZlNMoKh4VkAe1gKe81waSlspac7nXgd7dU+boHCakkIfmQBC7g8stYJIsg9kw3DgTCcO2Fht+1IsmiNkt9JzoGaiyfiCeyyPDVWM5PxlbBn5TC11mblUWGzuavwkNLJ1atalyfdq4HGlyyzJN1rhvNgjFF2wgBOTj57ufNlMzqn5XjNzbuxxkpQQmV+YWdC9f1IzOehrC17duU3ejrFK+OV9EKPhRMbMiX+LGBjUElzCnU14PFO7kZziNyglfXB3MQvLNUy0qjai/BOSDLuOB7VVNWom4S99PRSmuXpEq8y7xRvuAn+696T4i8mlx/xntLby4hO1jrgjKCO6UmvpvY07R3zpryj9YZ3tOFmDcVelTuO0leiJFqEkAuolGjs1OfGUaMZdVudfjtMUP9EQFu75CWHjDRQ4BEOUoX7V6oldrhzc/izd4cfv3rAKlxtTJrYYbI5S7Eepj/SvtWMAGKchLCNCUGVeiLPKU6RuCRKmPUPrYLfTph8vxMvBp2ZMOjxS6ZeaMfnlhsSKZYICeA2xWeQxKQZXgl7GzY9bASUlRlFRUYsa8MtdLpdwrIuJorf4MYyNOzI9hygaRITtWqzJF0YKUivzH7IfZ8Ob7KpZFbXwe6nD73ff+ntvb09urHNbTm8XaXIgmJQtEvY4S0o4KJLvxp5aZi/29EVzfCD4R6TLKKIMFjtfnZt9Po/eMM7bw3ffNfbu7W1t/UA7DS7nz4c3X7L27v1cHjjq71bd+Arc/CyIk4M81Q7uqLYV5U3iXrBaEATrbjz/V7cXwODmcJbfbdpvTRXgzVukKJtEqzhPHVKReUI4Qqh6UZcPmZnzz1z+qXnZi+dufDcS8+/cOlvzp+dfXbm4Ls5dvSo03HUYTE/0YrdimrTQlHNGJhp5zbAKIjTMHV4c53rrOgK9tpcMDMQ62uA2ZL9OmG1r7qSDPebMh2BUsfoRtnDdh921Aqed14vXkd5IS/VGNslYaeT5GiNcgZpWROKto+DAuELUUp3Kv0l8v6Xa18iNobm9JD3P90po1iNW4IJ0qROuk/kKrUyPw+YRb+c7vl4YbHBH5vBtsfJH5vJ0n/lD83o3LPWOnvTduYh07J9Y06VHrV138O4czxa8t20KhX3WATmapCCzbNWuW626hpj1c2XF3Pnip+5lSvXK9UYlJ9FXWrKL5q2i0suFASPF1ibjRuv8lo/kfbyaTy8ideZm0MnjriaWChULufe3kVCtLWhsMJk0urFHdPj64Tuz6OdX2pt+xziktHkJNP1xuuTKyEEyU8d3pSCaS9efxZ/tEQmwlGtFXeWQYZ2uaSpMjblhpbVtz+mIFTRDedOtHD+o/t0zzJ4gGGPBCkgdrnGKEQyanxExRNHcHJUzzO5C/WEDlhOEXuyNZTj+cP1+MYCUEH+DmmWDccTyeFQdtz6qBpLzLVe0eUs6naibjgJgBmTqI7L9zyLGL6jpbnAyKwSfmdmgIOmYIV2HR5jedmXy3e+AomiiN5ZUEuB3xsHaeH3iXfSe6G/upir5EC6hC6XMfosJldz3UcO8UQoljAPZ+XuMBFiXsNMGaU+aebEKOfzCcL0D1B9GsNypjEuZ5oGQ5AvWIwDugIadNDknl5M0l7QSp+JOuHTGxeDtEAMLIO7UHyFi8gDlxh9CMcGGnXkej3XM40zvijTtecMo5TLUIZJQffPY6aUXv7tvdaLW2GSPNOLu+nzQZoW2dy5ei0sFqaWoMlVbLLcw9GoNIecmy/5gvSMACYe5UmYPapLXzlCf1FwoeKIo6WkuXoVudhcDJKQ5Qg6vInjHWCEMAst1FKQTVSkrjhec4wxMBL1AM3cfGTVqXaHRTq3iyNMl57YQaECeNybsBMk6WRrJWxdDtuQpTjYKHMhchBJa4csFoUNFl6JpS6lA3HGPpDbjg9Y3D/AzTOMmbPAyzEvvT+1u4m4fvZ5y+TfLVwoBQ7CTjFQdZoJmiKPNrxjRx1sXCwBE7CP26nyBVR8+VS+eNRLxx9+fB0CvD/+h733bo3uPvLBkxHZVwSxNsbtIWzMDCGdcxqA8Lop9/WcNl4N/KGgCN1+TvuwRrD1Oj80Za73/AHp2TILLi6DYXh/3bk3fPPO8MNt8iY7yAtrwei9wtW0jxtosWw63D/0FcTXhQi3LHP/JNzD9JQFosUSsv9xnmQVev/Dvsk4Yfor6SLn93+SO+pP5f2Uf7OJmfjvZ5NWqSk2/3+Vh5PYfIDJcnjTMZThvzwafXxttHPLH9RG24/rrrvpT+CVJcbzR35l2dvrT+SOkwiff9THVa1e/lJx8rjosrGfRYUbUsBO59us8gND2X3kXhnKPTWxL9PZfE4kqZrPm/qflQC88NaqvEu+oUXN1/FqGILtRizjA1i9YrHmCT1l3/ul3/pOEYYvbuNZz0fN3FjmXc3RCZ2FkMOuAVvswazOLNWtq+F9ppu2xBRJKCQwpTJcwTJ9no0Z5gmXKsP2l+mtXKtcuTH8vfdvju7eGX5419t99GD45q/wlfXa/dH7n4C/3c694ScPPSXpJJNhvL13bw5/cX/3y0fiXYYI/97wsy1wRdx+jLfg7TeGP3swuvtw781HBiahY1+4hDJ7v2jZuihO1AT/TJgoc2+pUT8szGU2bsd/3Y9al0+322cQ51WDs+WOV3wHaRLOtAifmW6KvZjG7Vik+Iza876SI/kQb4N5xwtbHjhNBFE34cu7Xid8ZfO2Wu72cu0BYysB0bPK+jOSmfMtKdyGu+0a/PM8cxyW3BUppfknVc7Sf5N50+ssGIB3PKGchMgu89zWdQnqfvFHWzt7r9/du7XtD7y9Gw9Gj9/hKWMQXu/B/4dL9vod3YN0QUuyhzzP5P6BBKeD5XEGXfXYQkOyjk9YteiFBQv0YBYVoHH/Wa4sYMF/ry7X6sKOxEopXGHZ7LrvbGLx1Y9XrKmdh3BsHlwwxeSxpjcbT56NvdFXj4YP7njDzx8O39k+6MAKtrhmL5y9cGlm9vTsSzPnZgBOC7m6CdFCU54PUPcQR9fwECkJctN8vLX383/wRjtbfsOLWnEX4NFu3/C9QUOrGXUn13rxci9MEqL2vbfV2m9ZtduAIaFUe29r+MubSpXtd3xvMAEyrTKKi6e/f+7SzPn/ec476R07enxC6uNjHgTyXLQapRCGc2Hx7+DBBeGpkFYgChMm0mrMQG9cnij65Clvjv0TfKsbRn/z9Yn68QmIWYXOWNgHKP0xRIih5ilRLAlbzRpNMqBFSZ3Au46XdLK0yAOzHYVIUKbrZIqdNZiYYAo7SZQ4xdleq6VBclk/h7n6q0ibBRXxfIG/lLOEaZgIZFFo57kwWKrhiVtHwQXaYzWOE6QyHSQQO4NDxT4bGFjFfmh4SdzvtUIJEoRTIIbD/XuSyyhFArlihk+eVBrR1WEsEERptK73QSvGdEUYG3x/DbPduKm309rG7fjpOOi11QeBSMK9GHbELMtVixdEtmyzBWEOcZqhnwEjsl+Pu457YJV25uMJBef9rR1E6r275f3F4U1scvAXPBU7CL0slzNplnBrdNTOeQe8Sd5eRatDlRlULv+BJrOwcASUdmA+2NQlK/E62zb6jmkFPWjMlaEx6KVRqyMfO1BazbbCvaZRrIFvvioPtPvh+e5SzGxL8Vn2F9u02Xqd8yGKtd2HY9Tv95bB7bjh+UkcQ0Q2O2Dns/hC3uZ0M427Yb2uECRDgXkRVkIhW8L8aauffVKEHJSBcBlFbTXASvIP8k5oy0xdEKo0lcNWnvhSno9YPo+xXF70rTpaXJlOl12W5Tb3fE32yZIxGsUrKxNKKQioM5yO2MapUdPYMLrqRAgYcKEcu6FkPqPDVwSbsSzF4PCVVFk9GonhK6myurF4O0yDqJPYy4R9KL9MWPlc6nmTqzz59SQ7nMO2bx7KB6D1wAFSCg7WaZaAO42N7N2meuNKHLV1zYDdRI0NreGpPOV/iavc0vQMvLCThEZvnI3ExPJWTexucqZZWWoxinS/ZabVzvJrTalM8assnCANc9oHQEzRARTNXzHgMKCUpdgiUuGh2eS1ndHH2/hEunvT19+Qq1F3ueQ2xLIFJx4U8bXy2gQEaahsNX7sE7usX5ZXyIO+zq6FjKp2P2QA0N7hTfWSGSzo1XUOipIocRgF+Xm8MPz45vCXN0F44BJMu49utmrLFAf6YV19hsoTpxWvrnXCNGyfTm1+yI8VuCLrOGdMFOAQ2VRVnS8LX2+/47EHkxi1Qjb3QvofdZUFSlOCc6wBhXNKGwXckyU1HhJJgFldIxacu0i4OYgFBA+55czBPCb7TvIqx8d4YIkU0Sw5kpMoVkCdWPaLdALKpHCriD57vKCxqHlRNpBQClLK04XqQDh2KCxnDWkT43L/sIUShxiiTwXRDvcaoaSbQsnG8dyzTc8NToCCcOFYdlo56/rREzqzz1VxpDTZl2OKwMpEFGxDDisB0TQGPFNpaCYukBtcyxk2jcZkDCUPh2k96rbj9aaSOJA3BviPYRqS3DvuDRre0XJU5gjTCBFPTs5JMT22I4wbEYytpAbXUje8wK/b1YVcfhblGm6KyYTzga7HBOpQ7cFOnh+cf/H0pXN/e/HCi7P8fPJOepseV8tNef7sBe/sBXjQqfq2Kc8//4J38cUL33/x3MwMAHDF3XDK889eeOGc7w2OE40/c/7cc2dt/V8XDYuKJu6FuOk3vL+LesFz2i9tphmfwhdgw8MtOeXVLrHtegkUzw0vkgH1kcg5YCr++HMs65C/De1+tQ9096jnOXlKf73JHuUMcZVjmLR6ETvIG0rKdNbbWfKrSg9dQicsQz7g/GHsAe44U6qx18OsePmWf1BM4yqf5gNPpptzGh/mj1OwMmpv081kBbIDZgMDSAtmBcYvl9rUpzl/Bj56KkPms8+K/RhyPflWxkh9QaytBImqCr7I/1ZZL37LX4SSy3wE7PJEGsxO2Tel1xnxg9qt/DF/9dl7eE65vedNRaS5IeJ2rG4HtAvUuE6sbu4J1Mk51j885YnG2bmUWH3w373a6PVXR1uPeFI9skcva4Pqmb/+2CPSJGE1XFXH93y4Gnu10QdbANAz/OTd4W9+bXb5PKtB9QTFsAWyKy78K72d7Yce/OTVuMA8unN9tHOL4Kwo6Roia9rskYmJ7dOpxV1mL217teE7nw4/vOuaS1HO1a14QJr9ZsK63bN8ptSkkO/oW5R09K70YhLQCzthkFjsDtc68Qbn+PDBg71/vE+xOivlF23iOV82o54xvPtL+J43fz3Lf7QXSNBK+0HnRZL20/jN4x8FdSrddIl8+lmPl2h6LXLUM5bqbZ4eVj86D0l+l4JWeL6tDOml894T3vkjz3jnzxpD0b/kD6EfXYpE85eidkaj1q1Kutq6g+QwSaNVWPh/HfBVGMVdY0bOiTLeX5/2slLU1BQUzR+gpOXST4JLLVnZmCxHKaKAOSSVNbmEOnjFpNIcRs1igWIu5ZXLZxEjIZc/VBHzax5n3MQ52JK0VsJ2vxO2DW7MiN/FyY/JJp0Hv168xIFktOciT4m5U4h7LkhSj//s1YyAG5M0tXCZk9KKtiIJk/nDFJlLuEnXeC5R8YNJ0cWsbj410nGenjrpXXfRJkZxvVO+alNGliiQBlmdS914/VI+cWv93lqsi6TyF40X8tcCVrBydGetIA2X4546/jP8J6+2+8X94e+2zDk4k1XJ71i07bgLkyRa7oJ6C/FJ1JtQfvHEJ+0atD8X3IGywiWEOsmjJ2xfDHsJmjB1csK2J7/Y1KhfyxATti+tYXnHiYvPIxTN4p79Vs0+EO/V7GPBkYrFL7VY8Tw6Xgx/0g+TNCQoUT8RtKifS1HTExWK9u0Ze90qu1L56ti3pRexum/zF7RCnJSpKdqEYD56/e5o61PqRrAKV6OSd1BA5EvoKeIgkn/0aqPrdxzXllW4EpF93oFOpKExYfm4eWAAoTN5MWzBKQAFwJkD7tovtne/fMxTULP0znWHOsWs7NvKE125dAl1Sg2PuS06lCmdeFlG8WnkE3DdnXhZOoRSeN6deDl7gD3xBLSNj2xZaWHu8KZaaDDvsR+g1GCB1L+Iz/CC1TowgsRIXUm2eshl41wiZaSare3hV1ujN+8NX7szev+BS3iA9pW+f8D+VHvlP+X3BxXoDsBzLOouw4pQVRZymYC+4p9v7r32FfPBMLdFVq7MmJWGXANeVKl4esboDn/I7+bpGbrhJbXhZ8yGnylu+BlHw2214bNmw2eLGz7raLiv6hpemjWflLPFL8mUbrgXwlZtn+XGN6WXF9kXT3xKvNruw2vDnV97w/uPRlvb5vRb5UusAq1B5xssTFKCvtkwSVXiACT9zXvgG0TTp5cvQZzZoIu+lnXliXuOP4Jcl51arFiizLva+taFJm4xToLrKlOLFa8h/eJCF2HpwAetnntlLe6lP4JGagixw2xg0jixmet4H3bBqxNsofAPKxCc525QnWDRvVLGX3OVfrCsB5NThYTpGIlkNk7FXMDp5dedZkJiqXeiBP9bw4p1JS03/oC+zV1AKOlEfx8iN+oC7/7pOO6EQbfOERobnhIvN+XplXjzemwHsPlvossRwo+yApytnEIeqsBGiDNVb/bCtU7QCmtHXu5Nv9w9stzw/BOLvVPal6v488svX/WNHiVRcLswZfRzUTdMintnjk1ZPCAkjEgFEcrvwC+AH4C5h/820160WqurkYQ693KqygH9uDY9NTf5ra+v/e/5qy+3n5xr1ufrLydPHmkgR4p6sJmO7y3E8BFafVwxicEA/M1q1jYWCMOE8LPTh1TTto1D3gK8SOa7BMHlMtF4U3iViH6EN/EClRhE2A9OuudZo1Pj+ALmbTy8CX9bQCScIXOczIbXbIpW5vnyf7mrJ76ZMABMX+6yElqurH7Uaf9AHjYXg41OHDCH4aTBNnSinzS9eD3hXh0JzV1WC79xcMFTZc6zuhZJhAWe5RmzPNkOO2LkmcsC/+EnxQ2Fs0rBxIzXk4Zi1b8cTXlzC1evcuQyglR5JihksH/X6+K0uXrVrw+uXl3AqYAusJlevI5zefXwZi9ex5/UBmVlqLtQV6cuo3AlXe1MeQsMG/YUB08FnFSa4IUT6QqD24eeJvF3CnGfMYoB7p/SUowToxxgEu2FugS/HSDSqgBW5TCqOEh94IxOMfYa93jJVscCIFeXpTaZY3HQJNXsxHQfxwMEOraGYPyA4xBArgwzYeDYIzCBs+ErB7NLampWjuSy8WZMpqjIH2r25+S0Nsrssnl+TA/07ca9p+Vs1jY5HeDNQh2chpc7K8yVL3hMcgdzzUlUPSgzc7ysrf5oPCL5mxhOUPD8sI9o7HhweFOz83sLHoRdKL8N4BffHywoPgWcqyK+XnLWzqIzl3mZZO4fmjuGEqeQbbe8zFhCdmIsyCZznnjmcxGBaoyFLvG63EdIsZhTweSqcFE3pAnJDFUa4HD6C4iUzC+psXIFOoglqSyQl4oIndwnqcokPccXXz7fTMFHbYygLf8+G8DqzTpvJivRUlqrs81hiQhKwQKu0BM4sKNcWT1TvBjUDYlCvXXxDJnyzHuBOrrgkrDWfb3eYKeR6xT+QRJ3D+QErnbAuuao7KlLsYmNdMr7wcyFF5oJrqtoaaPGPsErq+E9VTcZ0Yo7nWAtwQ0xC6N7ekMJpDG4gGYKls4N8B/WhMMqY4tYJkKg1t0PD7HKzZWAS60y2qnO2wXXSP1Tw5ubV5YRL7ZsFquzteh2LpxrNpu8Mlshtfo8TguzuxBXEfNJCsVYZ8KUlcVa2ouBlaxbQYrCR1k21QS0dDyfjk3oWGnY8tzRed7WhA5iJusD5zR3Rxv6bFr3h5ywIdH01kSYcx1qij88EYdsbWD9QBVMnTs6r2MXsT7039jSzHho7R/3O2mw4Hqi64JuFoqTTLmehUiAWYf5ME3hMimYbV7WIsghe4sgGNBkl2ufF67SgeKOVKoPNZijQjfLnJtBcvlM3O/K2WTZ4bJzX8u0aAYxx2sb9vtwjf1XDVXuBleiZTAAQibMtUWIA55urveiFC0OPEjsjPiEkBAIeNPvtsOlqBu2teufxSATbbIma3PAMa21mr7Ume84vKT8KTwQnu7Ei7U5TngTPsw3vE0kbEot7Q0MLqpe6FRT8J60mmLF1Uf4oD4vY4mNiLSCwcKTo6b2VneHx4vpMp8qxoRV6ZHHM6pXEDiKZ4uCOYrr9w7zJH3h+8+dn3n20nOnnz733KXnT18Ej3A5asUfznSly8pQvmMuB7asVq5vUqGTVdaO25Mn3wcpa8F0sSHcdBSGGG4vluOM0q7u3eJrHi1KMQxE9xUP4Owb88nwNT8MpaZt//TzbZ26EcqwYCndakYK2tKRlbasBoTpQR0utw34lj1AKSS0976lsc8KKUZprVHKok7XUnuhTNzKKkOFovSJFioIvptYdl0hqbXiDiGo2eERzSReDWtLKHnLV1Yr7vD3KKUADbvLnShZeY5DNdA7eA7aQLkXvcHlX/pLhKAH5T37eYcGF06XDafIzS8aZYf4QBgixDRIIer3gVfDVEX8AVWH97780+5Bsd6ordgFCVsOYciHnpj9g1s+rIS6GoaZHiOkRBWyS/t8W5VmEZkAs7ta8kHUrpONYI6WH4YbajPE3HCJwlCy8lCBuv4aUrQarEfAksEfRaZpogNHC1kDl8ON9RhRKITSB37FuLWzLNBZ/T3stolfYV89HSQRDNbHnMNwGCq1XkHFzBkl9lXBz4AS4mU1E6yGMoolw4lA1ByIUetwbI3Z+BxbM3pTbA6Eg/+PmBrNeoFBa1BmJu7xLO3qYMSXs1EvbHEtmR8kLW08cPk+g9j9GLKHaaJsUqMYETGZbYMkk4/iTNBaCW1C+enwylrQbYdtAf6lLimt4GLQugxZ78sFgYvSRFzsKogVk6KAFmaOn8p1gEWJ1rtxGrIuPPwbldGMpexn3yBQjbzEAtqoV4SlogRJPN+8gyb21YiqZ6HOrrZXvpPF1Ked0NUyfvTVgnpALzq8ANLj7oMtAPLa/XzHYxKeRg3GFD4t0O5cNLFAQwkak9VxUYdFfLu4QeO/3fY1LrJpqeF4GmpFbf7VyWMV9TUbtzdKrte4vUGMQF09UESfviC5fDHohp3cWPGWGpctqxT0tQZlfLOOmpbwL06sfOfUsabEunvwjwKwDYHwThxZ+c6pvzCpZbhgOeRi3giVWFYDc78CoQn+6Vvf80fjqoX2nZW4w3aYhK757PrenUdZ3nEGvcSykfu6KREzz5dE4+Bp6vMp5aV8/eBLokRIT66eUAzJDj9Rw1zlu48ewCbcffRgdO+a3ctMNeiBDI95LrsYG/IRsffe9vAf38MAgIZSMnPE4UFWMv5LL8eBm8ywNKMxJUDLl8FcPstGPi/F29octxcyEZO0Oe0f4gD/W4BuYEi1CttzUArseVXLKm3UTSiXFwE7oNwKlcUL1ijmXuwhoIEmG4JQVWmZZjXMZTq6sQ0PxLuP7R7O8/Q1pU6QrIY8QRRMGqV/DRxBVtIFlW670uhEeWts//sNvkiN1iuNTJSnxiV7VkclKliTzS+6jBkN2YA2frnTZuPl5VyxQWODUa1gbWVYLykW90kKUG+xGL9SlllWRcm1Fv/Bp4nlvLHqN8x+QbH1QtwOa+K42nt9G/QLr973Rjvbo/ce+XWDmexFUJWXaq39sZK1VJ2Tej03I41yPFGdjo+nD0cyW6+aw+vdB++N7l7jIsjw1cfDj+57AFD+GiaDGt7/HWDP1Y0LmHeTnaWNbDM0zBXQMIismxINYG6UhKXipQumDYohjLMlfQmJVMovDTGmhmzcdnWqKCBmdSpIiEolS0R8qunt3doC7F4mGKKkOLq+PdraJmTE7Gn5dO6iVPmq1SniblbYd3Rc6ZC3alfdUERV154yaZQLwm4i73wSONVMXB+9d83ToAYQrvrOq6OfP8Q99Nn10e3fGoeX0uGzYSfvQZ6sBp0OMVSoZt6L/PWwsz38zSe//1JDXBCyuE0oH8wdSEjAnpTe7mcPdj9/PPz4pjWMvVufcPRVb/TPbw0/fyQQut98V0C03roz+viaN7r1ZobU6pPLzOY9P0uMUdobMjnXKftiYKULnwxQzN6JNoVPw8IQrWqEAbZ7FK5XPCvUWmVOC1shwlvQDhONomel82wJhul1iijiXXO/V6rz2dLqEbWCua6/3fSG//Jo+NF90HxILFQB5whKtqqvrjmukmtwzcre29v+fAMeQ9w4B19gh4/euAa7Z++NnzFbByv1dywI1AfnEH/+z+CNpHKp+JFkrAK+DdQZamgtUotZ7URvT9s2ANxyrh1BcGo5naEsX7A4oeBkiCX9AvKyNqkdXWnjlNsxfjl+qXotRXLB8g3lnGpoLTmVa9CONsAAj6KSyhde2IkwiRUneSn9zdlfXQ16GyXxLHnpZpJudCDApLccdV+MllfwIAj6aawL4UG3FXaqajyVSuZRM7zx/5gnDNjtq/Ygq+j8Wo3bk6008K1SlLZ3722AKf9i9Np9X58C8dxknGpo42korTpXAm9Ix8yMewhFjHYpWBO1LGAAzUdoKUJz5SmPNFR124QhCY2baJKiTVnggGKZxNCdyrJmSRcH2ARgZNIyDEig2czUBC4sQlNWN+J2bORc35VbmWi1rUD86S1yBKeqDWY6OLJZFSMpt2mirgLvyRzRvGmPbFV3mfKmvJI8Guizswpg/GHCRMln2OvKmim25Lph2EbxgNsYebBSM42fi9fD3pkgCWsG33iVJ57wDs0Z3o3SxU0HoZ5n9nZ+eZ6iArf0DjM3cdZZnczoIzEdTdOlwJ+3+O5qRQON1te2kXpA2lyfeMKrHWrzhYb/PZFZZPPJ5fZZu4VTwnbrrO9Ir2Mbx7PjIzOMG/Fhhi09c2SN2nUgzr2KLPGBWWhplEaxrKO2WgvmNUErcSbZS5Lp00h4wV+9mlcg8+l3l0OoOvIxaDJPY2mtrvkWmFsJWvVOGpZtdO7lLOLMM4M3WCYT0nJezxyim80m860Q7U+xDgfFTq16AE3mvJrP5mmvZlq/cTAih0jUHkxB0Snds1XON0NQmFLOBNqxtdRcliWG1xA0aYCFKnEy48CUjpY/YXq/ME7nrqM84rSZH0zBn1PsV04N/LOOQTeUw6nmYBD3Un1xWuFG/CvhqDGd5xevr/1aHbli/misV9U34+pV3VUDjlseCVTXQlXNA5fLIU5ZhoVtn2Lps4Uko3RlEsWC8xxdqr+6Ys7UqAQZoF4m2HxQ1/2YmpDUs1brhEtpw+uB7OxIfZvZBCC3QxY/AzWb2gXZiVtBBy+5oBfWeDFsWivX8PzLgKq56XX7q2Evagkw0yTsJhGzbgLcBQCtau5WBp9qhI/NSe5lg8uJUzzlTYp/44JGwpnj+yQbOfvLzFWJU6BNsBruYIib4MWrXBQX1hi6uLUDrrAUWuh8Y98v6iI2FGHsqdOOkrVOAFeZaGja85d7URtDCLp6CAGLOWPlTJfBMn5QBCWEncGoMFAufcO3Oewm/V7Iu1JGndRM+dxx2WBORZpvdVvwMHGN958iZY0nR8moC18BBy6uEc3P/6rmfbVzunLNqxiTneR1eOMe6GT33tsebX269967oHca/tM9b3Rje/iPW/kpXmlJbUAttczTTGckpf3PoOSjZJKj5fj0CpbrhkxfZrxznWUKNNtMD82V0JD4b/TBG1IRravj0b339lve8N0HQ8j3dWN798HW6O5Db/fTR8OPHrIMkh9ct7TTdrI1I9EDil6QTUcXy+rOg5XBUSYSDt3835yAZdZBDPz5Rk7xDCTZFjKcFTk8cknpcH6CSPtt/qQwZo5fSiwX2jzwiA/dlSgZDwJWHDd+jgYAsojF3TTq9h2Z7BkNeEGDwzG/1mG/4qi9aU8boxC6QGjjpeEfjBgTOcKSOjQxC2hkPtvWJwi+w7BvFs3BThfH4cJTyjU8P+z6VCjsICcItsq+gU0w2nl19P4nw7fujG4rW0AYc3ADZbYcKOaw5TjfhPkZ+b7R+6kEPwQjtjgjuLVq+Jt/1VILKof1aOseOk1teSzywziOj7suggXU4fHrwzi+9KSDRM7Bhve9o0ePljvqvaWoG3Q6Gw4uu1yMC09/kX2DvgBKXAJEZyxv2EWmra7VadFCSXKqlbbDSrNENsaZfNzxOFEeMnahJaH51DShajmhm9YXlf3iMSJSF7jZ/vCmIJOH+Q12H2x7v/9SOICyd2MiP376kGd8H97/3ejuTSzJ/AAk2EjWzoIR6Jp1qjfKe3S3U3xvWwuL5cPOesEftJazRhUDjuroYOok8h+9XMcmWq8XoAaVTOAnXJeLLZ9oXNLNnmYDxsEjDoKdLTAnalZ4mA/NmD66zUz1O9dGH/yqxBmssNR0ps7MbebWCbt2lIAKepIXgU5dvdola99hbE7DrnJpUggPLAVU2EXZ87L2yKaz1pZyMbGrd9nMlk2wJs/3YDXMy+mp6Z9yoVZ0cqICv0VoLuiFAUUT1m1ySIWnXN9NP+33b47ugpg82tr2dj//YrS9A17ailvIB28Md34F1yN50WUNC6M0IVvC/Jn6Rr2ynXaJefbI1FBms1KuUjqvHydVCa4eZCIx7XohGuioHkIw87xXoqhjB3YUD1B3kJmWUNp9hJqHnLA46+5i7eiKh2fXSfvUClfX0g3/lHRaYpeA6gSkijYnjrSjK8K3TImNZkYPNb4JDVjCb4I+i9d6edttrReaK3utV+icGXY6ajpYtaa+RfNBojKL1reP1iVeiZJF1mQ4B7XCKe6FXbDW10tyCf1G/pQ5ZAG4fDPcKV7JeeB3DpoAIoCm6Sf9sLfBXFXi3ulOp+anK3MGztm8nwEWAQRn0X2Xrsj0b9AIyin2wZCumPqUbJZASwtClQgrq5PVs6zQrz4cfvRbOJFv3/fgKce374fb3mjn1nDnvk/fuqZ2HE9lhfrECGW0VK8kWe6EeTWHsjmXHiqmMl8HjNBeqBrNQi/N/7G1ZoRyQnLLnBhO431d+HKhznVHMDH1uhGPDIVh0mnRJR8rPhnS8YxfinkommMZPGwZTEI4VROsAVCqhBemT3XWqugRnKX9zHcHtsplqgX6/UFwQ1TNETRcO8LqdproVgjCHmUIZLkuHYKyw25BGV1y1vaAnP4i8ZsSoDtEKI8FEKp3018r7XIl/te3dD5f//Rt3yqjPGiZvQgW+1ESNzZe71amAirZdLzjE6VISpQtzuXBSe+YNYjCQ5irZrGhOWEXOzbf8Myf5+dBS239ahfE+vPHjdPruLWGrHWDYx2DYIqGJ4EGimD8Qo1uDILhwBLxNDImgMPK9dcaOCCjijy51UdAL14ngPzIy4ArpjwdfhRlB9ddwL0/QN3KbTumxw3lSWPpvlxYdPi44Y3bCoF9QtGVg6DTJka1OuieXwnaHViLtITN4emqXFoMk6sgHoaBjVJHB/v0bAX8gSwhelazVP86NgFFxpkxL1G9dtFVapYWmeAFDOz59kCY6Xa2Rp895E/PBTfdhfF99AmsVpZE86I5JUvxWosGtESVK71cT2HqauS1yvXOC+dM9SxDDK5CQVbRuLa0mfv9l4Q+eSGHndkBCiQ3lG7yFrwEjlDXUkNrmdyo6rGrNkiKMDAM8UqtuDmVmiUXDLCMnDAQ0s5x/BbCt8qAgcoKWpgv7PwVByjxZrOIxnuFLWW08gg7BuAAHBLtUxpUvlj1dSJpm/b8r3/+GF9mX//8d8TLTFsgSZhmuOJ+0IuQddiS3xD+SJKYekFr4rhRiCFPnrd3Hz0A9Cni497/ejz66g58N+TgvFVe+TFcMH3eNFGCC/tZoSmiEDwXclaButzKSfqtbIvMzbtWsERkco3XuBaUUGY8TMIrYW+jlG+wcwXItkHiS8PeatRlHtWHHH1LGxK6h4/R92A/RpPK7+dyb2gMfe7F6/6B203Y6624d2fP4z7iqzzkCx7z1KS6yE2r36HCubnMHBFqWVnduIDnDm8WJH/HlHCKH3QOU4rVFHlqCcFAPGWEt/6U9VmcVILFyhlR6unFKOZ3FT4FBE1FZprspZbaMob+qnObaKRroDEZ4il+yvveUZdnkwBB61WXWOV7K+4VSKxayRKLDcrlNWE6yfzsXU+LtCUrjacBJoUZea5pIomUAxx8cpCvCiLspkdZpHBQA0c35oqBLgudtCyJy60RoPo2rqwSm5a+fRxX3343dP14tj1Fl3iyAyXG/U5SgFu+6OJm/kPFp4V2uEyUlXaIF4MyX4TEz0w4SnmGfu605grdR/T3YZ3W45Sy1jLQNA7JsPvgGroSSE8QzUhr6JQQcA+0Sdk5xHy6jLV0OdwAXZbfAGX/s0G33YEXU4auyB3B6sfNDrLitRCarHONEP6R5Q85h2mB/LogSLSjIgm6DxMsRQXulquSYUQ6iyO5mT6LUc8cWHEAogl1AAICSjDWbp3mqgmfV+wAkcGvKtUYAoCuNczZKRpCWvFZoqK1qlUr9qogh5XoVAWUVWpW7FNiepXoMYOqlbUq9maDYpXp1sa6tduR52R5Ugy0qDKCHoWp64KdyulbB5cobwczUHK1ZgyMC2eofI4nCggAFISHCKpn72fKQwNqArSHUtIRku80nw1ywIlyWMTCakxGOT2mc9yjjSgXR4Qnc0/Pid7JmiEcN/684YjKOiXbmA7uu8Q1fxtExrJDhczPS05W4NJcxa1ZTSmLbjb5+4rIk1MyDR+RQce9A8sklZoqlyTTzseWd2yAG77Lc4tNWVEmD70/3Dh6RTpjizuW4PDmGOdciQNOO9n8gXd4U2QWwRxhiiM6hKnhwafFSSzUywZ9WJER2VFaIh7CuSmlAKaA5AhEVy61idxV6j2q/KRvh1yfCfKgUKSypbjVx5bUfCxgjz0TdMJuO+ghsIOWTFjTNVHIFDbcBh4dR378cnvzO4PJl9ubT/H/P3ykCfnDUWuRxUya+aDnNsKg1/BW4266AqiNG2BHR0UHy5bnT/osOvYFjKG2wHC5iRhHojQFbgHYnJ4qjDXSjJIXghcQ8gRsvYAmAmfbNBLnTWG7bqaBUzmU0FkGfYOGhbf5TL/T+b/CoKfj3TPSJGNF4efh51odnAXqzbWgPQPiZu2phucf9Y0Bb9i1ceh1V0U+8IXDm0DhYPLwJhIB/2gHG6CaU8cJD6tZZaynu62VuFcL8D8ND9ZZw2sLHzWdA122aORssErKImHgVRgIByT4dawCFhfGAPxLY0fWE5emhSdr1tR6GF5WWsKeRUOMM96TXu273reUxtTW8iuaBIhFjN6mKuP4dlZYR2XYS1bCTgUwPizuBLji/UxiKf/AEwzonRCZBnhGqHzsOKWnrHxhb1lRG8Mv7ielNZmiAq29zL4aflHXvrJKCKfX0d2Hox0EW999sKXDjcbtoCosl1KHJlErYEZS3hu+eUefkXwTgd43rnWy066t8/e/vvb/al8FPyBU/O5NnR/KRKtIfXEfQG2zATWwqXqV5BVJ2ouzsD+BchCuV0dbZCcQ4Mv/87sMQhEPEvjhl4/ZD+2AAd8D9PyfAaIiL6PFIKZp1F1Omurt9SNxchpdZGwshmPU02lk093weGqNrDHtJCMza6jrF22Q8gKpW9uLIysZl3FXqq85jCBePEZBbJHkCLvjMDCoG6+bSyuXjyATsZVkiiWJYp6m7z7lNUZAjC4c3mTD0IWJwfCNLU/9pIgOg9E/v7tgx5D2EuJW1ltteFaDDe8Y4ZMXMQlDbQ870LK48kLyUj3mTTIy2M26UbOzqXaCsYiEUTe8o3Z0bZxiyp/nAwh3CKNOraYT4D2JXSrSk3fE+27d+5b3XcO1D5IjcS9Y7+hx/s8TrAfx55MnvWO0h58poErmmL6oIMoJfmUcVCUR5kpvV+OZmlEgtR4lOQITkRK35xbfpPpUUplNBidx0lN/omY57LbVDhKDEWG3LVtPrPH/pQr2QW8YWcnYFJ7yibU3gOwvX1+DCGfolazCP2QVFsotje9WXxZJ0ZJIDnI5fCMHj/aN5JlCnba0BuoNAIuzHWAOujm8efkNDeDH7+F/RtfvwH+Gv/kE/rP76Dp+++mOP398Qj+qykmlUFKTRxdseRQvgsnDm/Af4cwgNxUi8YCsoM61GEcmNvBfimJiitxhCEcc2xGGGMIk7x+ekJM8F7Ppl0HFQ/Bqpqkyauc6LehO5Yp+8OmNs9nar5BiXA10Gwve9BCGrJjayyzKlRGmBIOrv8ogXy1fuVpCRBc7U5Wz1S8GyA4A1wBJZYMNz7lRfpm0g43CNxcsYZ0zwmAqRK961o4Gx4TfTRgrU+AB9zZT3wFbxzpRXL3E/TSJ2lrUqeTEc9V2jahRhieTzAGNqKxvlGy8wAzm5ylOgblMVbNRq88PRu+/C2ejN+VQ5egTp2400TnFBAmHSC1M2CFz83UaiU/b3CrknrG9ckD39JKZYl0fy2wJl0QOQICxfxUdlhhwXp6jEpYoOiqxb+bJNsnd2Nhf5oHJ+lMiCtSYEcU5nfSCU/3jx/KNz8N9ILsqcCDU3tY5/n9yRPR4kK2FZ/SxYw3v2F8ShpAUsZ6dCGbRali02bUEJTrbeGVzQNEqAeWFk6s78PPqpq/UhKMa93smXf9YsQKPNUidPish1ljqdBVy2HVKYCZh+zaWN57ciXloNejuU3FhYp3CU5U5ElE1TRXX3cejnVs0Vok5ZmyAdH6ypJXMKjBwqiegkqG6v4KaqSw+Wz24chQLxIVeUcuuvsGCK+EM76tWN03+0ObTcdCTvmUDQ41ZtODQr2ryWF1VEZaqI6uoCsvyDpmF7EP5Y3w28P+qOq7yXiE5ajS1RUOfNiaJ3MCAC9JlYeAVOYmp+OV0LwyssExNgxZ3FoOSZgFe2LWXF6HDSV5IzzkKX56pkkVVrZHfH5VJdbkftcsiJ2HZ/C6wiK8WN8+krx5yjJrhdUBN9TQ3EhWWT0Eq0mDpq6TLTVypcJFkLQdukpNVN9lnbtxE8fIzFaLM1vxD7hWooCslJT0K6Y2mN3tSI8EUflv9XoInBS/EdOBR3EU1muF4JNsGs2+v7q1H3Ta6e4dBD36K+6lVSHn06V/ghczqJ8yODLUpd3PXccD2PFSO2/GPGH7yc9FqlBKlyINDahxKkWHZivTTQ8OlqflNa6lREGThK+l05mpAf05C7kcXxV3Mylhjc9bgc2eKVLpWd9Dwjn3nqHJSKvvpJ/2odflH+WmRdOuPrOHaVlhgUsmLpOVE7nRQDYXBwnreYhDXUDf1L49YxlD9MwgXAM8HtT/e2vv5P0DEsV4k6k6u9eLlXpgkarF7b+vF2IO7IWyAu1/dHH18zaDlStjjyZZ3Hz1Ab5yPrw1f+7WRjhlAvGWS5T+fDMsFtq6/ztaEbejKpr/QzqUUHVNcUChRWistKhSdCznChGGPYvdr+aTRrLxrh2C6aHYbW5Yv4ahdPd24kkT8v3L68ILFfVZL1GS0LyegeHEra6MXr5YVSER5Kkd19k16Sxg5v2UJUpI4K2hRhIiMyplwLegF+Xn5VGFPq5O7kBNRyqdqGvLf/20RNhtXYd5s7GIdfJGMMxKK8+9Ots3GNtNQouHq9pJZ4kSNXHZhKd+sYYbsvbYz+hgvndH7D8wEdv01aOiseizlnqJn1WNFrnDzFCWX0kljzeWUZ/OoMPqbPKGzaeXb1X3BmNwyd+J4VWfjMSpm0z3m216ZFxU0iJ4LrcQ3cUcalx3X2slJaUgeN/QzocE52MgYQr1lRVpEnthb3v8NpdMGe2Uar249S2bWpH6v45fTVXJmqjXy38FZ3kz1tGMZYWbWozT3CavKEmoV57HCCk0mWMqXTlpICooDn8OjmyfE5RoY/P3G/eHOr6q6Zy1Wc9JDxuX46Knf8+71RSX/phZXDLy+ArtO3waMKc/HoN4QN71NUrWoZ3cPpiQh7XjsykEHf8F5zHaY60uVr9BjgVVneSLHmstuW/xudr6IVZW3vgS1raVmJR1Qe0RTG6vt6DsxaLcren7KGq49EbTbk9oyy2oYV+2/P77hjV6/zuBirMJlbQxnkFpmY6gXsUI2r7OBBXdU5IRaycUMHoGs8UOrR6WrhdgTFtdC1XDzBTiSxcQgR4r4obasswSDrgsRwzSQE6WKix9YREf9UrqrCqymVXIhmuiFVCgTZad/HwqJVHpUvXHf0VrD3kmamn0r31XOW4H1Z3TED1dZg+MQEPVC3A5rXNs6/HwLogV3v7g//N2WTK7DkhE4juZD2tlbd69ChaQieeK0TLhsmxA0mydroG4YEpjzSYlj3Eiry83CRfrjek7eXVWLfhovTp7frhNmcChHj5saQvnQcKhnoN/ACKPIpLQf8XeX7bFgz9w3ku45t4tvLlVzoXvVQOUXUwiF7VmB+EmhfzrzxTJU0BlhHjnEFw34rRTlVWZU8r+U8c6bWSj3mXbZMKNrJOcnUxZZlMV7NFtVZF5l8smEGZJlQzyxx1mea5mqkZt3mXpyuXs4RT3RctvXdt1JvL0gm5iaeFRkpD4kM1IXNCE06GQrWomChlQ9u7sxtVRBg9wFLn90MhO32FbG39r+8k5ww3cRW7mi/2D7LtW1nkSczjGel6xbv1Vacb+LuQkvLP4d2NOXevHquW7ai8KkNnvh7AWOM3ZuBqNBRUenFA0y+w1wXhoKNL1xJpnnkEl21kid3ydMb6yn+e6FSb+TCk8kuxN+E3HvSe3HCTUPF4OcPbxpFtITaE15Cxx1B/Jj0X1hIq0jXn6LnOG54sZJQ9zY1GyftJhARD9adNrxAElrJWz3eW62wnkyY3nU1VuvW2m96NRoC4c3lalDFz2mQ4DwbwB+OLwpqRKpyTJjnXd4k63SJj9nBur3e2/L77olb54VY0YL2QRsD9UnUPVNHlhqngr6nVzFjlDoKLjVfPHHS562zerOjNrWXOnXbPkNNl6SaFy9shHtKNp0pMpQBRvmr2pIRdyJVZfHnCBvtCMseswa7TIvWr3ZUlhtPBogXErPouRpueN+73vf+97ksacmv33MCXCJg2LVbSfd3PqcY7x7Y7iiWQd/rl7VOW0KuW7e5fNpYJ0fVxSVr3eSx/aj74amDJ7LFss8NI2r/OLp75+7NHP+f55ztSq8qbWXxjTfA1OekfdHJcVqsRV3+qvd8mHfHD6pv+oOlMavvlVcpNDBdxXfcsqGMwmLkjMCYtkKcxQfzmDLSSYMK/uXJjcPxlnpUdz+44WtlwhdR5JsGHrxhq0M4p7mqmR4dxYSe1oA+J7qQNHqlEzzoDZgd4fdVxkYNAOL1r9yHGlr/VWGgHfDv6tjtXHfaSRufUwIws3AuB/7diBotTQuVMhSxpaoFXcHnsGlBYv3JiZ8h4ywwGu7Cg+hvJuD/W7qm4X1cSgPcempbdNeSf0vzyO56UXCzdzNb0Ez8c8YLqWcB9608o1DdKqfp5TPENZDHiW2y61BDcQGNptN2dT8gVsM9Ph2xukGmyP7zHMHtUuXQzWNIqb1Gc/jnoj9y3W4L+1nz30+MR23CuZpJQiwBmx53WcRx279bU42FEfGF0fie/WqrjskxfGzwVjNlcoOkxMa4sgVw4D7CzLG7CtrTF7mGFwpPCsElnGKk2OlL85PYax2TmcvtozPs/yiVDPcFia1pXMgLxzeVBsVAVvZfLhzimiNmhRNZ67VCP7njW4/FKjPHILwtgP3WbSZpBsgagi/Zn8tjrqplU1HrVHWzseBiZVRzh2drzsXTHH+ZiX5BBndZ7fDLSP4oO8xaLwGUyHW6yT8vXXsmEjH+l4jc3qqZ4VFI9EFSSQorzQaB/pJf0h7LTzxhN4rvwFOlEgV3gtXg6jLE2iplSepJqlAvKjb6uG2FDgYq1G3pj99Glk3dE69OGg/Pw5wvKjo2vHwncKAl/WsfSpHg0qZDDqdbVk5DPb1tV+P7t5ccDRdHSU+/0F5Un+GPmk8L13JDZ1+/HbSE2tpirHQ61Axep1utyvNnajkfq3IEvkvg6DdpioRjgv8PPzdu7sPrpFVsuha463z+qt7r7Nks8L3gTezQDRTBmxbl5MQdBsC58JuejZcCvodC82dlUnSeO1iL14LGAaSWYjyrwCYwYZHSr+DfAFTDEh/PLNi1hDbvWAZzAMHMUrQLCAO5VLYawKM5bmlJQa55UMAIC0pGkH8QM8kElQwYHIknTBAJynHUPD4Ff3G3TSIugmHTu+FADTcnkUE9Xrdpo4Dyu+LwHhtf2yuRpRyziM4rj1HDE0gqPmw6Y6sdYKo6zvTjhmGWjP3LvRx8qRnJacRj5u6x7w4ZqXaid+XhUucKay1exf5oGPDuA0PWF/EypXV+H/DCv3BxMTEkSPAsX39D9p46ntNYdEZ7twc/uzd4cevHkjbEwBetBqG8EIzI+3A7VZ4WbAQhOdZwR9G3Xai6Azm/OVwNepG4IkZdIPORhIlPjyc1MbNnNaYJfu4FdfKu7hwJewxMFu+hXgzZGzrgYe28s5wtyHkDxXgOlYA576jMt+/Obp7h0OX58ZmUpOqkn+ZT6KTUYg1kAj6sXgOq+A7FQkEv8+wDZmnM2Ml1M5myF3sD+8+Hn72a0gxv7f1wOrp+bDbLzf5onS5IU2uht2+r3KC64QUShuyzQxdMtsX38d/8fkbfniX+TDL3dLw/NPns6/e8Hdbo627ukMzNM+VkuBNRvs0V06jNn4OtDK5z3JynqmHCcNbirptqvmKCcxzsoRpXWL+cuhSSSukFRA5zHWyMtHdOqroq82RBszlHyjnV31eytXqAtvSg7mCKrEAgTMMwDoGs2AA5RiMe+WxZqGwsaPp++GkuCEwWdYX26MbO6Pr2x5kKgftCcS7fnBn+NY2+1GkUcfmi1N5O66kEpQE8N8pcXk514ExHb1wqRcmK6W5xMtbiAOvXx9+uL37+c7oq1/7ekn3mEkS9ci/HvOdLEcbljYpOws/jm6/Ndra9nYfXBvtPBrduZcptlid8g9uDvLc6S9HMC/B2lqT/YE614v4TzCW9q5ErbAbr0+uBt1gOTSRx+BYipd4O9NNeIB9vxMvBh0kl7MEH2JsloUk4td5nbwqtTzGKqDiMrmAP8PofSEGrTbQ6+29C8ARu18+Gt19hHkMbtwD15O997ZHW5/uvffu3q2H3uiXjwV8BL3VKzztA/O9vhq3J1tpkMUKUC/zvZsQf4gPbPV1HuS+pv/QU8rn4fyqdNUvnlO7zh9/UgPNnbsGB1qD7Z+G2OwNYD3p1y0jzFBEaYjGeFlVgqZduxUpIkrScrcHlCxzdUA5n/QFpwTVQr9vXinha+kKvKQROzDoXYbsZs9EnTCpsYQRS1GHBFlcWuW1V8M0gDfzmaC1wpI2RJ0Q/8C69WnwQeymq0EKLo9Xr3qbA1N+Ao5nptql1SYn8BJ+oLyKLUcEYTVQW+GocLL+S2trdn3upLMJ/lhhw1taZQugkTU5EItM+GSJV71TFsPnPko+wrvHrKr6ZXP8O2HJwj+BmOZikITdYDUUv602k7jfa4WX4Mf5/TtiS+KYz1jQ8BYtiVDYutHPSGFv0FSmqc3doQJGN+grmi2EoKP9lBapyotWZU1u5PPkFjMCJmVIUqe8SfFv0Y5++LtMpWJ3yMcD/4HaBdgGw1PnpZqlTGqmTVW0o5tTxa+GJVWxoMp6zHjKaTCORdpiilX50nXZTMvZSgnHK5edVJxsDlPpmCZSt2nU6A/14L5d0VJ2GfCTGq9oe2YZQ5/eTO7yUvZeab9VWY92X7VulRbzZCVMVlH3ck6XgWWpirqXy3Y4iY2jHbYbdPAvn2htpRcuKZsKj4a1wDTSYVHhrleuioYdXgWVsU0jOliDVPAotKqkW5Ik1j4PEbcRkuj9yyPAf9i55debvRDVXDV/FnQeHq2K5rdplbFBlTJjg3I+UZV8lDYZIXg2C00NPAMpVQ08Cy0lD42MWpDbhAR6tQHatVUiLlpicSloBplgkHZCkvPM2FDZ0MuqlVpbqFTxyerG4+PfbjuKZaZAkgcDb/Tab0c7pqsGr13ZAljWcFPaEnhA76Gcd1Er7i5FvdWzyGt+Wl8MuNMZ8SZyla9ZJ1G+QsFpu86MOzVYkw0+GYWZr1uZVcdSq+VlvR5kCelW9TuvzirmZ7vmGa5HHz6ADIO33/KGH3+Qad8RkOphTrpr10sLeq6XxEQkFqPDTKOmhTbxaihMw4TEM0wKsAzJaW94x/5KheOzYUpPdzo1I6VgsNgJOdQEA7yQAG0+fjOTacWuwnE79ok3oaM4/yriXrAr+Pp0IRqHpFiJki5Zk1Ovi+Xl6iqjEf0Sl0DGzWnP/49fvHNDmAlHt98Y3n/o7d3Z2nvvE7icJCfB83r7De4pwQFV4PL6j1/cfuffH/2jdXtp+mGNVtwrK1G7jXCHh0w+iVR38TrQ24s7T4NlTkmbwIvLXyDsVDsQMt9RaOX02lonCiWmLMQ0orMY1GNsE4A7Wfy3Hpty9SrdJLzFyAbxA9mcErPIh1bMIJ0VMuPFYifEo6Iyg3VzeHF1cjWWq6uvxgklZ4YgSUVsAH1a2O1fWAvhcjOCgpkeIe972GnTnwdZzypBbnuMtAq49pvsVW48chQTygqiV8aEuijYEMfoU+eN3au9wI1+w057rG4Vlqu9ys3CfdtEEJARwQr/O8E9V7SP6hSg/Yr5s3JvW+UwIJnNgmP9xU7cuqwnd57y/C6LKp7Q2ebswMHZCl1wFuX0QDGxdAfMh4bYTWxxz3AG2Sgmz8iRUd84Tfan7CAigFGADgmKkrnyyxOE2OwmX+To7BkoUdTBbKukC8jF9Pz941JJeyRlSDCqYLnFvTr2bt3Z/XzHY/4OYH1hLg/Dj1/FKI3rd7zRB9etEI3BQXodffto0xvdfTj8DJJ2H5y7kS5qsjzQE6Y8Vs60pAp5uvgoTy6tSPYHL0XECCmC6/EJxCYwBL6xSMuE1YOkzJYoxyEuE40Pmj421efhTWNThnXEg2dCPp9N9CfttUO4U+ovHxs2Kq+FRPeOcuJGZepd90vK8ZRS3lC6bOvwMidO4Az+XPvz2FNHzfRKgwnkOnpbvsjMha51wbjPFwdbFJBjvsByqxGgaC2ms3/MWUMi9BhamXkjTk5XfemqDaDxdKfDoleYj2mo4w4c0nQcGYcMXitWXJvgYrPu6PG2asbVmrCUY3qyOcVHn5qpdpTA5MPTPsNIcRXWbhStV585xnu7Dz4d3dgBJ9avr33kK5xOexsGS4L1IBJTTTO6Zq/XbpxGSxtTSKtTCTTwlqJu0OmYPRaM33gZVGcCMuLrn/4rjxIQj2PGE9/Ki8l2Tw42oL1piCPLqQR0PJD01at+U6qM+WoyBCV+NmeD1V4q39RwTdr1AetfnVw6sAFnT6RvbrwaaeZwlY8VRktPf9FwpdxbYaxFI1UWzjfUtJCrD7xloZzkOSTPQEPPBt12J+yxGBFxS2jXkH5BOJ+qV6/mvTLxK/VCrKv6r0PSKV2ErjglHqOBb1wBk7fUBhMT0mBUYtII9uP8HNjD5VjTA6fRh9cPOlxCG/vCwsLE/w9v6wRLL6wEAA==";
// END GENERATED DASHBOARD ASSET

// Organization-specific analysis templates are loaded from an optional local organization pack.
const PLUGIN_ID = "servicenow-manage";
const LEGACY_PLUGIN_ID = "clt-servicenow-worknotes";
const ACCESS_TOKEN_KEY = `${PLUGIN_ID}-access-token`;
const REFRESH_TOKEN_KEY = `${PLUGIN_ID}-refresh-token`;
const GOOGLE_ACCESS_TOKEN_KEY = `${PLUGIN_ID}-google-access-token`;
const GOOGLE_REFRESH_TOKEN_KEY = `${PLUGIN_ID}-google-refresh-token`;
const GOOGLE_CLIENT_SECRET_KEY = `${PLUGIN_ID}-google-client-secret`;
const FIRST_RUN_SETUP_VERSION = 1;
const DEFAULT_SETTINGS = {
  setupWizardVersion: 0,
  rootFolder: "ServiceNow",
  instanceUrl: "",
  authMode: "bearer",
  clientId: "",
  oauthScope: "",
  redirectUri: "http://127.0.0.1:42813/oauth/callback",
  workNotesFolder: "",
  autoCreateWorkNotes: true,
  autoDocumentSearchOnNewTicket: true,
  autoStatusSync: false,
  statusSyncTime: "09:00",
  lastStatusSyncDate: "",
  autoSync: false,
  syncAtTopOfHour: true,
  catchUpOnOpen: true,
  tokenExpiresAt: 0,
  connectedAt: "",
  googleAccountEmail: "",
  googleClientId: "",
  googleTokenExpiresAt: 0,
  googleConnectedAt: "",
  googleDriveContentAccess: false,
  googleGrantedScopes: "",
  organizationFeaturesEnabled: false,
  enableDocumentAutomation: false,
  changeRequestTable: "change_request",
  serviceRequestTable: "u_service_call",
  incidentTable: "incident",
  koreanHolidays: "",
  autoHolidaySync: true,
  holidayCache: {},
  lastHolidaySyncDate: ""
};

const CR_STATES = [
  "New", "Assess", "Authorize", "Scheduled", "Implement", "Review", "Closed", "Cancelled"
];
const SR_STATES = [
  "New", "Open", "In Progress", "Pending", "Resolved", "Closed", "Cancelled"
];
const STATUS_GUIDES = { CR: {}, SR: {} };
const CR_SLA = {};
const TABLE_BY_PREFIX = {
  CR: "change_request",
  SR: "u_service_call",
  IN: "incident"
};

function cleanInstanceUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function cleanBearerToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function normalizeTicketId(value) {
  const match = String(value || "").replace(/\s+/g, "").toUpperCase().match(/^(CR|SR|INC)\d+$/);
  return match ? match[0] : "";
}

function tableForTicket(ticketId, tables = TABLE_BY_PREFIX) {
  return tables[String(ticketId || "").slice(0, 2)] || "";
}

function fieldValue(field) {
  if (field === null || field === undefined) return "";
  if (typeof field === "object") {
    return String(field.display_value ?? field.value ?? "");
  }
  return String(field);
}

function rawFieldValue(field) {
  if (field === null || field === undefined) return "";
  if (typeof field === "object") return String(field.value ?? field.display_value ?? "");
  return String(field);
}

function normalizedServiceNowFieldName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function serviceNowField(record, candidates, options = {}) {
  const entries = Object.entries(record || {});
  const byName = new Map(entries.map(([key, value]) => [normalizedServiceNowFieldName(key), value]));
  for (const candidate of candidates) {
    const field = byName.get(normalizedServiceNowFieldName(candidate));
    if (field !== undefined) return options.raw ? rawFieldValue(field).trim() : fieldValue(field).trim();
  }
  return "";
}

function cleanChoiceValue(value) {
  const text = String(value || "").trim();
  return /^(?:--\s*)?none(?:\s*--)?$/i.test(text) ? "" : text;
}

function extractTicketMetadata(record) {
  const category = cleanChoiceValue(serviceNowField(record, ["u_category", "category"]));
  const criteria = Object.entries(record || {})
    .map(([key, value]) => {
      const match = normalizedServiceNowFieldName(key).match(/^(?:u)?(?:category)?criterion(\d+)$/);
      return match ? { order: Number(match[1]), value: cleanChoiceValue(fieldValue(value)) } : null;
    })
    .filter((item) => item?.value)
    .sort((left, right) => left.order - right.order);
  const serviceCategory = [...new Set([category, ...criteria.map((item) => item.value)].filter(Boolean))].join(" / ");
  return {
    shortDescription: serviceNowField(record, ["short_description", "u_short_description"]),
    ticketCreator: serviceNowField(record, ["u_ticket_creator", "ticket_creator", "u_creator", "creator", "opened_by", "created_by", "sys_created_by"]),
    ticketRequester: serviceNowField(record, ["u_ticket_requester", "ticket_requester", "u_requester", "requester", "requested_by", "requested_for", "caller_id", "opened_by"]),
    serviceNowCreated: serviceNowField(record, ["sys_created_on", "opened_at", "u_create_date", "create_date", "u_created_date"], { raw: true }),
    purpose: serviceNowField(record, ["u_purpose", "purpose", "u_service_purpose", "service_purpose"]),
    serviceNowPriority: serviceNowField(record, ["priority", "u_priority"]),
    assignmentGroup: serviceNowField(record, ["assignment_group"]),
    assignedTo: serviceNowField(record, ["assigned_to"]),
    serviceNowCategory: serviceCategory,
    serviceNowUpdated: serviceNowField(record, ["sys_updated_on"], { raw: true }),
    estimatedQaCompletionDate: serviceNowField(record, [
      "u_estimated_qa_completion_date",
      "estimated_qa_completion_date",
      "u_estimated_qa_completion",
      "estimated_qa_completion",
      "u_est_qa_comp_date",
      "u_est_qa_completion_date",
      "u_estimated_qa_date",
      "u_estimated_qa_end_date"
    ]),
    targetQaCompletionDate: serviceNowField(record, [
      "u_target_qa_completion_date",
      "target_qa_completion_date",
      "u_target_qa_completion",
      "target_qa_completion",
      "u_qa_comp_date",
      "u_tgt_qa_completion_date",
      "u_target_qa_date",
      "u_target_qa_end_date"
    ]),
    actualReleaseDate: serviceNowField(record, [
      "u_actual_release_date",
      "actual_release_date",
      "u_actual_release",
      "actual_release",
      "work_end",
      "u_work_end",
      "u_rel_date",
      "u_release_date"
    ]),
    deploymentFinish: serviceNowField(record, [
      "end_date",
      "u_deployment_finish",
      "deployment_finish",
      "u_deployment_finish_date",
      "deployment_finish_date"
    ]),
    uiInterfaceIds: serviceNowField(record, [
      "u_ui_i_f_id",
      "ui_i_f_id",
      "u_ui_if_id",
      "ui_if_id",
      "u_screen_id",
      "screen_id"
    ])
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hashId(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 20);
}

function protectUrls(text) {
  const urls = [];
  const masked = String(text || "").replace(/https?:\/\/[^\s<>()\[\]{}"']+/gi, (url) => {
    const token = `__SNM_URL_${urls.length}__`;
    urls.push(url);
    return token;
  });
  return { masked, urls };
}

function restoreUrls(text, urls) {
  let restored = String(text || "");
  urls.forEach((url, index) => {
    restored = restored.replaceAll(`__SNM_URL_${index}__`, url);
  });
  const missing = urls.filter((url) => !restored.includes(url));
  if (missing.length) {
    restored = [restored.trimEnd(), ...missing].filter(Boolean).join("\n");
  }
  return restored;
}

function localIsoDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localIsoDate(date = new Date()) {
  return localIsoDateTime(date).slice(0, 10);
}

function addCalendarDays(start, count) {
  const result = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  result.setDate(result.getDate() + count);
  return result;
}

function addWorkingDays(start, count, holidays) {
  const result = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  let added = 0;
  while (added < count) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6 && !holidays.has(localIsoDate(result))) added++;
  }
  return result;
}

function utcServiceNowToKst(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
  const date = new Date(raw.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return raw;
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 19).replace("T", " ");
}

function parseWorkNotes(rawWorkNotes) {
  const raw = String(rawWorkNotes || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const segments = raw
    .split(/\n\n(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.flatMap((segment) => {
    const timeMatch = segment.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (!timeMatch) return [];
    const headerMatch = segment.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+-\s+(.+?)\s+\(([^)]+)\)/);
    const author = headerMatch ? headerMatch[1].trim() : "";
    return [{
      id: `work-note-${hashId(segment)}`,
      time: timeMatch[1],
      type: "Work Note",
      author,
      content: segment,
      priority: 1,
      url: ""
    }];
  });
}

function buildJournalWorkNotes(rows) {
  return (rows || []).flatMap((item) => {
    const value = fieldValue(item.value).trim();
    if (!value) return [];
    const time = utcServiceNowToKst(fieldValue(item.sys_created_on).trim());
    const author = fieldValue(item.sys_created_by).trim();
    const content = `${time}${author ? ` - ${author}` : ""} (Work notes)\n${value}`;
    return [{
      id: `work-note-${hashId(content)}`,
      time,
      type: "Work Note",
      author,
      content,
      priority: 1,
      url: ""
    }];
  }).sort((left, right) => String(right.time).localeCompare(String(left.time)));
}

function mergeEntries(workNotes, attachments) {
  return [...workNotes, ...attachments].sort((a, b) => {
    if (a.time > b.time) return -1;
    if (a.time < b.time) return 1;
    return (a.priority || 9) - (b.priority || 9);
  });
}

function parseWikiLink(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/);
  return match ? match[1].trim() : "";
}

function extractDescriptionLinks(description) {
  const text = String(description || "").replace(/\r\n/g, "\n");
  const candidates = [];
  const seen = new Set();
  text.split("\n").forEach((line) => {
    const urls = line.match(/https?:\/\/[^\s<>"']+/gi) || [];
    urls.forEach((rawUrl) => {
      const url = rawUrl.replace(/[),.;]+$/, "");
      if (seen.has(url)) return;
      seen.add(url);
      const label = line.replace(rawUrl, "").replace(/\s+/g, " ").trim().replace(/[-:]+$/, "").trim();
      candidates.push({
        type: "BS",
        name: label || `Detailed Description 링크 ${candidates.length + 1}`,
        url,
        modifiedTime: "",
        source: "ServiceNow Detailed Description"
      });
    });
  });
  return candidates;
}

function defaultWorkNotesTemplate() {
  return `---\n` +
    `id: "{{ticketId}}-WORKNOTES"\n` +
    `category: Work Notes\n` +
    `ticket: "{{ticketId}}"\n` +
    `parent: "[[{{parentName}}]]"\n` +
    `last_synced:\n` +
    `sync_status: Not connected\n` +
    `---\n` +
    `# {{ticketId}} 워킹노트\n\n` +
    `\`\`\`servicenow-manage\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n\n` +
    `## 개인 메모\n\n` +
    `이 영역은 자유롭게 작성할 수 있습니다. 플러그인이 덮어쓰지 않습니다.\n`;
}

function defaultAiPromptTemplate() {
  return "CR_TEMPLATE.md 기준으로 진행해줘.\n\n" +
    "CR No:\n\nShort Description:\n\nLong Description:\n\n" +
    "My Position:\nTicket coordinator / analyst\n" +
    "Current Service now Status :\n\nService now Working note(시간순):\n\n----\n\n" +
    "SR_TEMPLATE.md 기준으로 진행해줘.\n\n" +
    "SR No:\n\nShort Description:\n\nLong Description:\n\n" +
    "My Position:\nTicket coordinator / analyst\n" +
    "Current Service now Status :\n\nService now Working note(시간순):\n";
}

function bundledAnalysisTemplate() {
  return "";
}

function cleanDashboardFrontmatter(markdown) {
  let text = String(markdown || "").replace(/^\uFEFF/, "");
  const dvIndex = text.indexOf("```dataviewjs");
  if (dvIndex < 0) return text;
  let preBlock = text.slice(0, dvIndex).trim();
  const rest = text.slice(dvIndex);
  if (!preBlock) return rest;

  const fmMatch = preBlock.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fmContent = fmMatch[1].trim();
    return fmContent ? `---\n${fmContent}\n---\n\n${rest}` : rest;
  }
  return rest;
}

function upgradeDashboardRuntime(markdown, bundledDashboard) {
  let current = cleanDashboardFrontmatter(String(markdown || ""));
  const bundled = cleanDashboardFrontmatter(String(bundledDashboard || ""));
  if (!current || !bundled) return current;

  const hasCurrentRuntime = current.includes('const DASHBOARD_RUNTIME_VERSION = "2.10.1";');
  const hasLegacyDeploymentFinish = current.includes('{ key: "deploymentFinish", label: "Deployment Finish"');
  const sharedPluginDeclarations = current.match(/const\s+sharedPlugin\s*=/g) || [];
  if (hasCurrentRuntime && sharedPluginDeclarations.length <= 2 && !hasLegacyDeploymentFinish) return current;
  const currentStart = current.indexOf("```dataviewjs");
  const currentEnd = current.lastIndexOf("```");
  const bundledStart = bundled.indexOf("```dataviewjs");
  const bundledEnd = bundled.lastIndexOf("```");
  if (currentStart < 0 || currentEnd <= currentStart || bundledStart < 0 || bundledEnd <= bundledStart) {
    return current;
  }
  const bundledBlock = bundled.slice(bundledStart, bundledEnd + 3);
  return `${current.slice(0, currentStart)}${bundledBlock}${current.slice(currentEnd + 3)}`;
}

function upgradeDashboardPopupFieldGrid(markdown) {
  let next = String(markdown || "");
  if (!next || next.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.8";') || next.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.7";') || next.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || next.includes(".opus-popup-field-grid")) return next;
  next = next
    .replace(`.opus-filter-panel {\n    right: 0;\n    width: 260px;\n}`, `.opus-filter-panel {\n    right: 0;\n    width: min(760px, calc(100vw - 70px));\n    max-height: min(560px, 72vh);\n    overflow-y: auto;\n}`)
    .replace(`.opus-sort-panel {\n    right: 35px;\n    width: 260px;\n}`, `.opus-sort-panel {\n    right: 35px;\n    width: min(760px, calc(100vw - 70px));\n    max-height: min(560px, 72vh);\n    overflow-y: auto;\n}`)
    .replace(`.opus-popup-field {\n    display: flex;`, `.opus-popup-field-grid {\n    display: grid;\n    grid-template-columns: repeat(4, minmax(0, 1fr));\n    gap: 5px;\n}\n\n.opus-popup-field {\n    display: flex;`)
    .replace(`    width: 100%;\n    padding: 7px 8px;\n    border: 0;\n    border-radius: 5px;\n    background: transparent;`, `    width: 100%;\n    min-width: 0;\n    min-height: 34px;\n    padding: 7px 9px;\n    border: 1px solid var(--background-modifier-border);\n    border-radius: 7px;\n    background: var(--background-secondary);`)
    .replace(`    text-align: left;\n    cursor: pointer;\n}`, `    text-align: left;\n    cursor: pointer;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}`)
    .replace(`.opus-popup-field.disabled {\n    color: var(--text-faint);\n    cursor: default;\n}`, `.opus-popup-field.disabled {\n    color: var(--text-faint);\n    background: var(--background-secondary-alt);\n    opacity: 0.58;\n    cursor: default;\n}`)
    .replace(`@media (max-width: 900px) {\n    .opus-field-list {`, `@media (max-width: 900px) {\n    .opus-popup-field-grid {\n        grid-template-columns:\n            repeat(3, minmax(0, 1fr));\n    }\n\n    .opus-field-list {`)
    .replace(`    .opus-field-list {\n        grid-template-columns: 1fr;\n    }\n}\n\`;`, `    .opus-field-list {\n        grid-template-columns: 1fr;\n    }\n\n    .opus-popup-field-grid {\n        grid-template-columns:\n            repeat(2, minmax(0, 1fr));\n    }\n}\n\n@media (max-width: 430px) {\n    .opus-popup-field-grid {\n        grid-template-columns: 1fr;\n    }\n}\n\`;`)
    .replaceAll(`    filterMenu.appendChild(title);\n\n    for (const column of columns) {`, `    filterMenu.appendChild(title);\n\n    const grid =\n        document.createElement("div");\n\n    grid.className =\n        "opus-popup-field-grid";\n\n    filterMenu.appendChild(grid);\n\n    for (const column of columns) {`)
    .replaceAll(`    sortMenu.appendChild(title);\n\n    for (const column of columns) {`, `    sortMenu.appendChild(title);\n\n    const grid =\n        document.createElement("div");\n\n    grid.className =\n        "opus-popup-field-grid";\n\n    sortMenu.appendChild(grid);\n\n    for (const column of columns) {`)
    .replace("        filterMenu.appendChild(button);", "        grid.appendChild(button);")
    .replace("        sortMenu.appendChild(button);", "        grid.appendChild(button);");
  return next;
}

function upgradeDashboardTodoCreation(markdown, bundledDashboard) {
  let current = upgradeDashboardPopupFieldGrid(String(markdown || ""));
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || current.includes("function openTodoCreateModal(")) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const replaceSection = (target, startMarker, endMarker) => {
    const replacement = slice(bundled, startMarker, endMarker);
    const existing = slice(current, startMarker, endMarker);
    if (replacement && existing) current = current.replace(existing, replacement);
  };
  const insertBefore = (marker, snippet) => {
    if (snippet && !current.includes(snippet.trim().slice(0, 48)) && current.includes(marker)) {
      current = current.replace(marker, `${snippet}${marker}`);
    }
  };

  replaceSection("extractTodos", "function extractTodos(", "\nasync function readTodos(");

  const todoHelpers = slice(
    bundled,
    "function appendTodoToMarkdown(",
    "\n\n// ================================================================\n// 8."
  );
  insertBefore("// ================================================================\n// 8.", `${todoHelpers}\n\n`);

  const boardActionCss = slice(bundled, ".opus-todo-board-actions {", ".opus-todo-group-toggle {");
  insertBefore(".opus-todo-group-toggle {", boardActionCss);
  const overdueCss = slice(bundled, ".opus-todo-card.overdue {", ".opus-todo-card-ticket {");
  insertBefore(".opus-todo-card-ticket {", overdueCss);
  const todoFormCss = slice(bundled, ".opus-todo-card-timing {", ".opus-todo-status-select {");
  insertBefore(".opus-todo-status-select {", todoFormCss);

  replaceSection("file cell", "        case \"file\":", "\n\n        case \"cr\":");

  const todoModal = slice(bundled, "function openTodoCreateModal(", "function openWorkLogModal(");
  insertBefore("function openWorkLogModal(", todoModal);

  const tableBinding = slice(
    bundled,
    "    tableArea\n        .querySelectorAll(\n            \"[data-todo-add-index]\"",
    "\n}\n\n\nasync function changeTodoStatus("
  );
  insertBefore("\n}\n\n\nasync function changeTodoStatus(", `\n${tableBinding}`);

  replaceSection("todo card", "function createTodoCard(", "function renderTodoBoard(");
  replaceSection("todo board", "function renderTodoBoard(", "function renderAll(");
  return current;
}

function upgradeDashboardControlVisibility(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || current.includes("showAppliedControls:")) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const insertBefore = (marker, snippet) => {
    if (snippet && current.includes(marker)) current = current.replace(marker, `${snippet}${marker}`);
  };

  current = current
    .replace(
      "        todoGroupByTicket: true,\n\n        filters: [],",
      "        todoGroupByTicket: true,\n\n        showAppliedControls: true,\n\n        filters: [],"
    )
    .replace(
      "            filters:\n                Array.isArray(saved.filters)",
      "            showAppliedControls:\n                typeof saved.showAppliedControls === \"boolean\"\n                    ? saved.showAppliedControls\n                    : defaults.showAppliedControls,\n\n            filters:\n                Array.isArray(saved.filters)"
    );

  insertBefore(
    "const fieldButton = dv.el(",
    slice(bundled, "const controlVisibilityButton = dv.el(", "const fieldButton = dv.el(")
  );
  insertBefore(
    ".opus-control-chip {",
    slice(bundled, ".opus-control-visibility-button {", ".opus-control-chip {")
  );
  insertBefore(
    "// ================================================================\n// 25.",
    slice(bundled, "function renderControlVisibilityButton(", "// ================================================================\n// 25.")
  );

  const bundledVisibilityBlock = slice(
    bundled,
    "    const showControlBar =",
    "    sortButton.classList.toggle("
  );
  if (bundledVisibilityBlock) {
    current = current.replace(
      "    controlBar.classList.toggle(\"opus-hidden\", !tableMode);\n\n",
      bundledVisibilityBlock
    );
  }

  insertBefore(
    "fieldButton.addEventListener(",
    slice(bundled, "controlVisibilityButton.addEventListener(", "fieldButton.addEventListener(")
  );
  return current;
}

function upgradeDashboardTodoDetails(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";')) return current;
  if (
    current.includes("function openTodoDetailModal(")
    && current.includes("clt-todo-completed:")
    && current.includes("todoSearchKeyword:")
  ) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const replaceSection = (startMarker, endMarker) => {
    const existing = slice(current, startMarker, endMarker);
    const replacement = slice(bundled, startMarker, endMarker);
    if (existing && replacement) current = current.replace(existing, replacement);
  };
  const insertBefore = (marker, snippet, sentinel) => {
    if (snippet && current.includes(marker) && !current.includes(sentinel)) {
      current = current.replace(marker, `${snippet}${marker}`);
    }
  };

  current = current
    .replace(
      "        todoGroupByTicket: true,\n\n        showAppliedControls: true,",
      "        todoGroupByTicket: true,\n\n        todoSearchKeyword: \"\",\n\n        todoQuickView: \"all\",\n\n        showAppliedControls: true,"
    )
    .replace(
      "            showAppliedControls:\n                typeof saved.showAppliedControls === \"boolean\"",
      "            todoSearchKeyword:\n                typeof saved.todoSearchKeyword === \"string\"\n                    ? saved.todoSearchKeyword\n                    : defaults.todoSearchKeyword,\n\n            todoQuickView:\n                [\"all\", \"open\", \"today\", \"overdue\", \"done\"].includes(saved.todoQuickView)\n                    ? saved.todoQuickView\n                    : defaults.todoQuickView,\n\n            showAppliedControls:\n                typeof saved.showAppliedControls === \"boolean\""
    );

  replaceSection("function extractTodos(", "// ================================================================\n// 8.");
  insertBefore(
    ".opus-todo-board-actions {",
    slice(bundled, ".opus-todo-board-guide {", ".opus-todo-board-actions {"),
    ".opus-todo-board-guide {"
  );
  insertBefore(
    ".opus-file-cell-actions {",
    slice(bundled, ".opus-todo-completed-badge {", ".opus-file-cell-actions {"),
    ".opus-todo-completed-badge {"
  );
  replaceSection("function openTodoCreateModal(", "function openWorkLogModal(");
  replaceSection("function createTodoCard(", "function renderAll(");
  return current;
}

function upgradeDashboardTodoSummaryColumn(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || current.includes('key: "todoSummary"')) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const todoColumn = slice(bundled, '    {\n        key: "todoSummary",', '    {\n        key: "serviceNow",');
  const serviceNowMarker = '    {\n        key: "serviceNow",';
  if (todoColumn && current.includes(serviceNowMarker)) {
    current = current.replace(serviceNowMarker, `${todoColumn}${serviceNowMarker}`);
  }

  current = current
    .replace("    file: 96,", "    file: 52,")
    .replace("    lastChecked: 92,\n    serviceNow:", "    lastChecked: 92,\n    todoSummary: 116,\n    serviceNow:")
    .replaceAll("column.value(item.page)", "column.value(item.page, item)")
    .replace("column.value(page);", "column.value(page, item);")
    .replace(
      "column.value(\n                            item.page\n                        )",
      "column.value(\n                            item.page,\n                            item\n                        )"
    );

  const currentFileCell = slice(current, '        case "file":', '\n\n        case "cr":');
  const bundledFileCell = slice(bundled, '        case "file":', '\n\n        case "cr":');
  if (currentFileCell && bundledFileCell) current = current.replace(currentFileCell, bundledFileCell);

  const summaryCss = slice(bundled, ".opus-todo-summary-cell {", ".opus-todo-create-modal {");
  const legacyFileCss = slice(current, ".opus-file-cell-actions {", ".opus-todo-create-modal {");
  if (summaryCss && legacyFileCss) {
    current = current.replace(legacyFileCss, summaryCss);
  } else if (summaryCss && !current.includes(".opus-todo-summary-cell {") && current.includes(".opus-todo-create-modal {")) {
    current = current.replace(".opus-todo-create-modal {", `${summaryCss}.opus-todo-create-modal {`);
  }
  return current;
}

function upgradeDashboardSharedTodoModal(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";') || current.includes('app.plugins.getPlugin("servicenow-manage")')) return current;
  const marker = "function openTodoCreateModal(preselectedItem = null) {\n";
  const bundledStart = bundled.indexOf(marker);
  const bundledBodyStart = bundledStart >= 0 ? bundledStart + marker.length : -1;
  const delegationEndMarker = "    const backdrop = document.createElement(\"div\");";
  const bundledEnd = bundledBodyStart >= 0 ? bundled.indexOf(delegationEndMarker, bundledBodyStart) : -1;
  if (!current.includes(marker) || bundledBodyStart < 0 || bundledEnd < 0) return current;
  const delegation = bundled.slice(bundledBodyStart, bundledEnd);
  return current.replace(marker, `${marker}${delegation}`);
}

function upgradeDashboardFieldOrdering(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";')) return current;
  if (!current.includes("const ROOT_FOLDER") || !current.includes("전체 업무 현황")) return current;
  if (
    current.includes("columnOrder:")
    && current.includes("opus-field-drag-handle")
    && current.includes("function bindColumnReorder(")
    && current.includes("opus-filter-display-toggle")
    && current.includes(".opus-filter-display-toggle {")
    && current.includes("padding: 11px 8px 5px")
    && current.includes("showAppliedFilters:")
    && current.includes("showAppliedSorts:")
    && current.includes("적용된 필터 조건을 표 위에 표시")
    && current.includes("적용된 정렬 조건을 표 위에 표시")
    && current.includes("data-todo-ticket-id=")
    && current.includes("function handleTodoQuickAddClick(")
    && current.includes("openTodoDetailEntryModal")
    && current.includes("data-todo-list-ticket-id=")
    && current.includes("function openTicketTodoListModal(")
    && current.includes("function handleTodoListClick(")
    && !current.includes("const controlVisibilityButton =")
    && !current.includes("opus-header-drag-handle")
  ) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const replaceSection = (startMarker, endMarker) => {
    const existing = slice(current, startMarker, endMarker);
    const replacement = slice(bundled, startMarker, endMarker);
    if (existing && replacement) current = current.replace(existing, replacement);
  };
  const removeSection = (startMarker, endMarker) => {
    const existing = slice(current, startMarker, endMarker);
    if (existing) current = current.replace(existing, "");
  };

  current = current.replace(/const SETTINGS_SCHEMA_VERSION = \d+;/, "const SETTINGS_SCHEMA_VERSION = 9;");
  current = current.replace(/todoSummary:\s*\d+,/, "todoSummary: 142,");
  replaceSection("function createDefaultSettings()", "function loadSettings()");
  replaceSection("function loadSettings()", "function saveSettings()");
  replaceSection("function getVisibleColumns()", "let settings = loadSettings();");
  replaceSection(".opus-field-option {", ".opus-row-height-section {");
  replaceSection(".opus-popup-field-grid {", ".opus-popup-field {");
  replaceSection(".opus-todo-summary-cell {", ".opus-todo-create-modal {");
  replaceSection("function renderTemporaryChecks(", "// ================================================================\n// 23.");
  replaceSection("function renderFilterMenu()", "// ================================================================\n// 21.");
  replaceSection("function renderSortMenu()", "// ================================================================\n// 22.");
  replaceSection("function renderControlBar()", "// ================================================================\n// 25.");
  replaceSection("function formatCell(", "// ================================================================\n// 18.");
  replaceSection("function openTodoCreateModal(", "function openTodoDetailModal(");
  replaceSection("function openTodoDetailModal(", "function openWorkLogModal(");
  replaceSection("function handleTodoQuickAddClick(", "// ================================================================\n// 28-1.");
  replaceSection("function renderTable()", "// ================================================================\n// 28-1.");
  replaceSection("    const showControlBar =", '    controlBar.classList.toggle("opus-hidden", !showControlBar);');
  replaceSection("function createHeaderHtml(", "function bindColumnResize(");
  removeSection(".opus-control-visibility-button {", ".opus-control-chip {");
  removeSection("const controlVisibilityButton = dv.el(", "const fieldButton = dv.el(");
  removeSection("function renderControlVisibilityButton()", "// ================================================================\n// 25.");
  removeSection("controlVisibilityButton.addEventListener(", "fieldButton.addEventListener(");
  current = current
    .replace('    controlVisibilityButton.classList.toggle("opus-hidden", !tableMode);\n', "")
    .replace("    renderControlVisibilityButton();\n", "");
  if (!current.includes('draggable="true"') && current.includes('            data-column-key="${escapeAttribute(column.key)}"')) {
    current = current.replace(
      '            data-column-key="${escapeAttribute(column.key)}"',
      '            data-column-key="${escapeAttribute(column.key)}"\n            draggable="true"'
    );
  }
  if (!current.includes("function bindColumnReorder(")) {
    const reorderBinding = slice(bundled, "function bindColumnReorder(", "function renderTable()");
    if (reorderBinding && current.includes("function renderTable()")) {
      current = current.replace("function renderTable()", `${reorderBinding}function renderTable()`);
    }
  }
  if (!current.includes("    bindColumnReorder(table);") && current.includes("    bindColumnResize(table);")) {
    current = current.replace("    bindColumnResize(table);", "    bindColumnResize(table);\n    bindColumnReorder(table);");
  }
  return current;
}

function upgradeDashboardTodoPagination(markdown, bundledDashboard) {
  let current = String(markdown || "");
  const bundled = String(bundledDashboard || "");
  if (!current || !bundled || current.includes('const DASHBOARD_RUNTIME_VERSION = "2.6.6";')) return current;
  if (!current.includes("const TODO_PAGE_SIZE = 10;")) return current;
  if (!current.includes("const TODO_STATUSES = [") || !current.includes("function renderAll()")) return current;

  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : "";
  };
  const existingBoard = slice(current, "const TODO_STATUSES = [", "function renderAll()");
  const bundledBoard = slice(bundled, "const TODO_STATUSES = [", "function renderAll()");
  if (existingBoard && bundledBoard) current = current.replace(existingBoard, bundledBoard);

  if (!current.includes(".opus-todo-load-more {") && current.includes(".opus-todo-ticket-group +")) {
    const paginationCss = slice(bundled, ".opus-todo-load-more {", ".opus-todo-ticket-group +");
    if (paginationCss) current = current.replace(".opus-todo-ticket-group +", `${paginationCss}.opus-todo-ticket-group +`);
  }
  return current;
}

function summarizeTicketNotices(entries) {
  const items = Array.isArray(entries) ? entries : [];
  const ticketCount = new Set(items.map((item) => item.ticketId).filter(Boolean)).size;
  const labels = {
    worknotes: "워킹노트 생성·갱신",
    status: "상태·작업예정일 갱신",
    documents: "문서 연결"
  };
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  const details = [...counts.entries()]
    .map(([kind, count]) => `${labels[kind] || "기타 변경"} ${count}건`);
  const failed = items.filter((item) => item.failed).length;
  return `티켓 ${ticketCount || items.length}건이 자동 변경되었습니다.${details.length ? ` · ${details.join(" · ")}` : ""}${failed ? ` · 실패 ${failed}건` : ""}`;
}

function defaultTicketTemplate() {
  return `---\n` +
    `id: "{{ticketId}}"\n` +
    `category: "{{category}}"\n` +
    `status:\n` +
    `purpose:\n` +
    `short_description:\n` +
    `priority:\n` +
    `service_now_priority:\n` +
    `ticket_creator:\n` +
    `ticket_requester:\n` +
    `service_now_created:\n` +
    `assignment_group:\n` +
    `assigned_person:\n` +
    `service_now_category:\n` +
    `service_now_updated:\n` +
    `estimated_qa_completion_date:\n` +
    `target_qa_completion_date:\n` +
    `actual_release_date:\n` +
    `배포일:\n` +
    `ui_interface_id:\n` +
    `change_complexity:\n` +
    `작업예정일:\n` +
    `status_changed:\n` +
    `sla_basis:\n` +
    `마지막확인:\n` +
    `서비스나우:\n` +
    `jira:\n` +
    `BS:\n` +
    `BS-한글:\n` +
    `FS:\n` +
    `DS:\n` +
    `ut:\n` +
    `관련 문서:\n` +
    `테스트 문서:\n` +
    `워킹노트:\n` +
    `created: "{{now}}"\n` +
    `updated: "{{now}}"\n` +
    `---\n` +
    `\`\`\`clt-ticket-status\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n\n` +
    `## 📝 작업 일지\n\n` +
    `\`\`\`clt-ticket-worklog-actions\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n\n` +
    `## 🗓️ 회의록\n\n` +
    `\`\`\`clt-ticket-meeting-actions\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n\n` +
    `## ✅ To-Do\n\n` +
    `\`\`\`clt-ticket-todo-actions\n` +
    `ticket: {{ticketId}}\n` +
    `\`\`\`\n`;
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(
      new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
      String(value ?? "")
    ),
    String(template || "")
  );
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePromptField(prompt, label, nextLabel, value) {
  const pattern = new RegExp(
    `(${escapeRegExp(label)}\\s*:\\s*\\r?\\n)[\\s\\S]*?(?=\\r?\\n${escapeRegExp(nextLabel)}\\s*:)`,
    "i"
  );
  return String(prompt || "").replace(pattern, (_match, heading) =>
    `${heading}${String(value || "").trim()}\n`
  );
}

function selectAiPromptTemplate(source, category) {
  const text = String(source || "");
  const crIndex = text.search(/CR_TEMPLATE\.md\s*기준/i);
  const srIndex = text.search(/SR_TEMPLATE\.md\s*기준/i);
  if (category === "CR" && crIndex >= 0) {
    return text.slice(crIndex, srIndex > crIndex ? srIndex : text.length).replace(/\s*-{4,}\s*$/, "").trim();
  }
  if (category === "SR" && srIndex >= 0) return text.slice(srIndex).trim();
  return "";
}

function replacePromptWorkingNotes(prompt, value) {
  const pattern = /(Service now Working note\(시간순\)\s*:[ \t]*)(?:\r?\n)?[\s\S]*?(?=\r?\n[ \t]*첨부한|$)/i;
  return String(prompt || "").replace(pattern, (_match, heading) =>
    `${heading}\n${String(value || "").trim() || "(확인된 워킹노트 없음)"}\n`
  );
}

function buildAiEnvironmentInstructions(category, paths = {}) {
  const type = String(category || "").toUpperCase() === "SR" ? "SR" : "CR";
  const templateName = `${type}_TEMPLATE.md`;
  const templatePath = paths.templatePath || templateName;
  const ticketPath = paths.ticketPath || "현재 Obsidian 티켓 노트";
  const assetsPath = paths.assetsPath || "티켓 노트의 assets 폴더";
  return [
    "작업 환경 및 Obsidian 사용 지침:",
    `- 이 요청의 기준 문서는 ${templateName}입니다. 제목만 보고 기준을 추측하지 말고 반드시 문서 내용을 읽어 적용하세요.`,
    "- Codex, Claude Code, Antigravity CLI처럼 로컬 파일과 저장소에 접근할 수 있는 환경이라면 먼저 현재 작업공간/저장소에서 같은 이름의 기준 문서를 찾으세요.",
    `- 현재 작업공간에 없다면 Obsidian Vault의 기준 문서 '${templatePath}'를 읽으세요. 작업공간에 보존할 수 있다면 기존 파일을 덮어쓰지 않는 조건으로 ${templateName} 이름으로 복사해 이후 작업에서도 재사용하세요.`,
    `- 이후 사용자가 '${templateName} 활용', '${templateName} 기준'이라고 말하면 저장해 둔 동일 기준 문서를 다시 읽고 적용하세요. 이번 대화에서도 계속 동일하게 적용하세요.`,
    `- Obsidian을 업무 정보의 기준 저장소로 사용하세요. 먼저 티켓 노트 '${ticketPath}'를 읽고, 노트에 연결된 워킹노트와 '${assetsPath}'의 문서를 함께 확인하세요.`,
    `- 일반 ChatGPT/Claude 웹 채팅처럼 로컬 Obsidian에 접근할 수 없는 환경이라면 사용자가 ${templateName}, 티켓 노트, 워킹노트 및 분석 문서를 직접 첨부해야 합니다. 첨부되지 않은 파일을 읽었다고 가정하지 말고 필요한 파일을 요청하세요.`,
    "- 채팅에 첨부된 기준 문서는 해당 대화 전체에서 계속 적용하고, 첨부된 티켓/문서만 근거로 분석하세요."
  ].join("\n");
}

function googleDriveFileId(value) {
  const text = String(value || "").trim();
  const linkMatch = text.match(/https?:\/\/[^\s)\]]+/);
  const target = linkMatch ? linkMatch[0] : text;
  const pathMatch = target.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  const queryMatch = target.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];
  try {
    const url = new URL(target);
    return url.searchParams.get("id") || "";
  } catch (_) {
    if (/^[A-Za-z0-9_-]{20,}$/.test(target)) return target;
    return "";
  }
}

function googleDownloadFormat(mimeType, originalName = "") {
  const nativeFormats = {
    "application/vnd.google-apps.document": {
      exportMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: ".docx"
    },
    "application/vnd.google-apps.spreadsheet": {
      exportMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx"
    },
    "application/vnd.google-apps.presentation": {
      exportMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx"
    },
    "application/vnd.google-apps.drawing": {
      exportMime: "application/pdf",
      extension: ".pdf"
    }
  };
  if (nativeFormats[mimeType]) return { ...nativeFormats[mimeType], native: true };
  const extension = String(originalName || "").match(/(\.[A-Za-z0-9]{1,10})$/)?.[1] || ".bin";
  return { exportMime: "", extension, native: false };
}

function safeFileName(value) {
  return String(value || "").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

function parseMeetingDate(value, fallback = new Date()) {
  const source = String(value || "");
  const fileMatch = source.match(/(20\d{2})[_/-](\d{1,2})[_/-](\d{1,2})(?:[ T_]+(\d{1,2})[_:](\d{2}))?/);
  const koreanMatch = source.match(/(20\d{2})\s*년?\s*(\d{1,2})월\s*(\d{1,2})일/);
  const match = fileMatch || koreanMatch;
  if (!match) return localIsoDateTime(fallback).slice(0, 16);
  const [, year, month, day, hour = "00", minute = "00"] = match;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${minute}`;
}

function cleanMeetingTitle(value, ticketId = "") {
  const cleaned = String(value || "")
    .replace(/\.(?:md|txt|pdf)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+-\s+Gemini가 작성한 회의록.*$/i, "")
    .replace(/\s+-\s+20\d{2}[\s\S]*$/, "")
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  return cleaned || `${normalizeTicketId(ticketId)} 회의`;
}

function meetingSection(markdown, heading, nextHeadings = []) {
  const alternatives = [heading, ...nextHeadings].map(escapeRegExp).join("|");
  const pattern = new RegExp(`^#{2,4}\\s+(?:\\*\\*)?(?:${alternatives})(?:\\*\\*)?\\s*$`, "im");
  const match = pattern.exec(String(markdown || ""));
  if (!match) return "";
  const rest = String(markdown || "").slice(match.index + match[0].length);
  const boundary = rest.search(/^#{1,4}\s+(?:\*\*)?(?:📝\s*회의록|📖\s*스크립트|요약|결정|다음 단계|상세\s*정보)(?:\*\*)?\s*$/im);
  return (boundary >= 0 ? rest.slice(0, boundary) : rest).trim();
}

function buildMeetingNoteMarkdown({ ticketId, sourceName, sourceText, meetingDate, title, pdfPath = "", sourceDriveId = "" }) {
  const normalized = normalizeTicketId(ticketId);
  const raw = String(sourceText || "").replace(/\r\n/g, "\n").trim();
  const sourceTitle = raw.match(/^##\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$/m)?.[1] || sourceName;
  const resolvedTitle = cleanMeetingTitle(title || sourceTitle, normalized);
  const resolvedDate = meetingDate || parseMeetingDate(`${sourceName}\n${raw}`);
  const displayDate = resolvedDate.replace("T", " ");
  const summary = meetingSection(raw, "요약");
  const decisions = meetingSection(raw, "결정");
  const nextSteps = meetingSection(raw, "다음 단계");
  const details = meetingSection(raw, "상세정보", ["상세 정보"]);
  const scriptIndex = raw.search(/^#\s+(?:\*\*)?📖\s*스크립트/m);
  const script = scriptIndex >= 0 ? raw.slice(scriptIndex).replace(/^#\s+(?:\*\*)?📖\s*스크립트(?:\*\*)?\s*/m, "").trim() : "";
  const participantLine = raw.match(/^초대됨\s+(.+)$/m)?.[1]?.trim() || "";
  const recordLine = raw.match(/^회의 기록\s+(.+)$/m)?.[1]?.trim() || "";
  const calendarLine = raw.match(/^첨부파일\s+(.+)$/m)?.[1]?.trim() || "";
  const sourceLink = pdfPath ? `[[${pdfPath}|PDF 원본]]` : `\`${sourceName || "업로드 파일"}\``;
  const sections = [];
  if (summary) sections.push(`> [!abstract] 회의 핵심\n${summary.split("\n").map((line) => `> ${line}`).join("\n")}`);
  if (decisions) sections.push(`## ✅ 결정 사항\n\n${decisions.replace(/^##\s+의견 일치\s*/m, "")}`);
  if (nextSteps) sections.push(`## 🎯 다음 단계\n\n${nextSteps}`);
  if (details) sections.push(`## 🔎 상세 논의\n\n${details}`);
  if (script) sections.push(`## 📖 전체 스크립트\n\n> [!note]- 스크립트 펼치기\n${script.split("\n").map((line) => `> ${line}`).join("\n")}`);
  if (!sections.length && raw) sections.push(`## 🧾 회의 내용\n\n${raw}`);
  return `---\n` +
    `${normalized ? `ticket: "${normalized}"\nParent: "[[${normalized}]]"\n` : `ticket: ""\n`}` +
    `type: meeting-minutes\n` +
    `meeting_date: "${resolvedDate}"\n` +
    `meeting_kind: gemini\n` +
    `source_name: "${String(sourceName || "").replace(/"/g, "'")}"\n` +
    `${sourceDriveId ? `source_drive_id: "${String(sourceDriveId).replace(/"/g, "'")}"\n` : ""}` +
    `${pdfPath ? `source_pdf: "[[${pdfPath}]]"\n` : ""}` +
    `created: "${localIsoDateTime().replace(" ", "T").slice(0, 16)}"\n` +
    `cssclasses:\n  - clt-meeting-note\n` +
    `---\n\n` +
    `# 🗓️ ${resolvedTitle}\n\n` +
    `> [!info] 회의 정보\n` +
    `> | 구분 | 내용 |\n> |---|---|\n` +
    `> | 일시 | ${displayDate} |\n` +
    `> | 티켓 | ${normalized ? `[[${normalized}|${normalized}]]` : "티켓 없음"} |\n` +
    `> | 참석자 | ${participantLine || "확인 필요"} |\n` +
    `> | 원본 | ${sourceLink} |\n` +
    `${calendarLine ? `> | 일정 | ${calendarLine} |\n` : ""}` +
    `${recordLine ? `> | 기록 | ${recordLine} |\n` : ""}` +
    `\n${sections.join("\n\n")}\n`;
}

function buildMeetingAnalysisPrompt({ ticketId, meetings, ticketPath, outputFolder, baseline = null }) {
  const ordered = [...(meetings || [])].sort((left, right) =>
    String(left.meetingDate || "").localeCompare(String(right.meetingDate || ""))
  );
  const start = String(baseline?.meetingStart || baseline?.meetingDate || ordered[0]?.meetingDate || "").slice(0, 10) || "시작일";
  const end = String(ordered.at(-1)?.meetingDate || baseline?.meetingEnd || baseline?.meetingDate || "").slice(0, 10) || "종료일";
  const sources = ordered.map((meeting, index) => [
    `## 회의록 ${index + 1} · ${meeting.meetingDate || "일시 미지정"} · ${meeting.title}`,
    `Obsidian 경로: ${meeting.file?.path || ""}`,
    "",
    String(meeting.content || "(파일 내용을 직접 읽으세요.)").trim()
  ].join("\n")).join("\n\n---\n\n");
  const baselineSource = baseline ? [
    "이전 분석 자료:",
    `분석 범위: ${baseline.meetingStart || "시작일 미지정"} ~ ${baseline.meetingEnd || baseline.meetingDate || "종료일 미지정"}`,
    `Obsidian 경로: ${baseline.file?.path || ""}`,
    "",
    String(baseline.content || "(파일 내용을 직접 읽으세요.)").trim(),
    "",
    "새로 추가된 회의록 원문:"
  ] : ["선택된 회의록 원문:"];
  return [
    `${ticketId} 회의록 종합 분석 요청`,
    "",
    `분석 기간: ${start} ~ ${end}`,
    `티켓 원본 노트: ${ticketPath}`,
    "",
    baseline
      ? "이전 분석 자료를 기준점으로 사용하고 새로 추가된 회의록만 이어서 분석하세요. 이전 분석을 처음부터 재작성하지 말고, 새 회의로 인해 변경된 결정·미결 사항·위험·할 일을 반영한 최신 누적 분석본을 만드세요."
      : "아래 회의록을 반드시 오래된 순서부터 모두 읽고, 시간 흐름에 따른 논의 변화와 현재 결론을 한 문서만으로 파악할 수 있게 분석하세요.",
    "추측하지 말고 회의록에 명시된 사실, 결정, 미결 사항을 구분하세요. 서로 충돌하는 내용은 날짜와 발언 근거를 함께 표시하세요.",
    "",
    ...baselineSource,
    sources,
    "",
    "필수 구성:",
    "1. Executive Summary - 현재 상황과 가장 중요한 결론",
    "2. Timeline - 회의별 주요 논의, 변경점, 결정사항을 날짜순으로 정리",
    "3. Confirmed Decisions - 확정된 결정과 결정일",
    "4. Open Questions and Risks - 미확정 사항, 충돌, 일정·테스트·운영 리스크",
    "5. Action Items - 할 일, 담당자, 목표일, 근거 회의. 불명확하면 확인 필요로 표시",
    "6. Current Status - 지금 바로 알아야 할 상태와 다음 확인 순서",
    "",
    "Obsidian 저장 지침:",
    `- 결과를 '${outputFolder}' 폴더에 '${start} ~ ${end} 회의록 분석.md' 이름으로 직접 저장하세요. 같은 파일이 있으면 덮어쓰지 말고 번호를 붙이세요.`,
    `- YAML frontmatter에 ticket, Parent: "[[${ticketId}]]", type: meeting-minutes, meeting_kind: analysis, meeting_start, meeting_end, meeting_date, source_name: AI 회의록 분석, cssclasses: [clt-meeting-analysis-note]를 넣으세요.`,
    `- ticket은 '${ticketId}', meeting_start는 '${start}', meeting_end와 meeting_date는 '${end}'입니다.`,
    "- 각 핵심 판단에는 근거가 된 회의 날짜와 원본 회의록 위키링크를 표시하세요.",
    "- 저장이 끝나면 생성한 파일 경로와 아직 확인이 필요한 항목만 간단히 보고하세요."
  ].join("\n");
}

function documentTypeFromFileName(value) {
  const match = String(value || "").toUpperCase().match(/(?:^|[_\s-])(BS|FS|DS|UT)(?=[_\s.-]|$)/);
  return match?.[1] || "";
}

function isStandardBsFileName(ticketId, value) {
  const normalized = normalizeTicketId(ticketId);
  return new RegExp(`^${escapeRegExp(normalized)}(?:_|\\s+)BS\\s+-\\s+.+`, "i")
    .test(String(value || "").trim());
}

function standardBsBaseName(ticketId, value) {
  const original = safeFileName(value).slice(0, 100) || "원본";
  return isStandardBsFileName(ticketId, original)
    ? original
    : `${normalizeTicketId(ticketId)}_BS - ${original}`;
}

function wikiLinkTarget(value) {
  const match = String(value || "").trim().match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return match ? normalizePath(match[1].trim()) : "";
}

function isLocalBsWikiLink(value, assetsFolder) {
  const target = wikiLinkTarget(value);
  const folder = normalizePath(String(assetsFolder || "")).replace(/\/$/, "");
  if (!target || !folder || !target.startsWith(`${folder}/`)) return false;
  const basename = target.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  return documentTypeFromFileName(basename) === "BS" && !/BS[-_\s]*한글/i.test(basename);
}

function isImageAttachment(fileName, contentType = "") {
  if (String(contentType || "").toLowerCase().startsWith("image/")) return true;
  return /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(String(fileName || ""));
}

function isVideoAttachment(fileName, contentType = "") {
  if (String(contentType || "").toLowerCase().startsWith("video/")) return true;
  return /\.(?:mp4|webm|ogv|mov|m4v)$/i.test(String(fileName || ""));
}

function workNoteContextSnippet(entry) {
  if (!entry) return "없음";
  const content = String(entry.content || "").replace(/\s+/g, " ").trim();
  const clipped = content.length > 320 ? `${content.slice(0, 320)}…` : content;
  return [entry.time, entry.author, clipped].filter(Boolean).join(" · ") || "내용 없음";
}

function serviceNowImageContext(ticket) {
  const entries = [...(ticket?.entries || [])].sort((left, right) =>
    String(left.time || "").localeCompare(String(right.time || ""))
  );
  return entries.flatMap((entry, index) => {
    if (entry.type !== "Attachment" || !entry.localPath || !isImageAttachment(entry.content, entry.contentType)) return [];
    const before = entries.slice(0, index).reverse().find((item) => item.type === "Work Note");
    const after = entries.slice(index + 1).find((item) => item.type === "Work Note");
    return [{ entry, before, after }];
  });
}

function serviceNowAttachmentId(entry) {
  const direct = String(entry?.attachmentId || "").trim();
  if (direct) return direct;
  try {
    return new URL(String(entry?.url || "")).searchParams.get("sys_id") || "";
  } catch (_) {
    return String(entry?.url || "").match(/[?&]sys_id=([^&#]+)/i)?.[1] || "";
  }
}

function adaptPromptToAvailableDocuments(prompt, availableTypes, hasBsTranslation = false) {
  const types = ["BS", "FS", "DS", "UT"].filter((type) => availableTypes.includes(type));
  let next = String(prompt || "")
    .replace(/\s*첨부한\s+BS\s*,\s*FS\s*,\s*DS\s*,\s*UT를\s+분석해줘\./i, "")
    .replace(/\s*첨부 문서가 없다면\s*,?\s*그 이전 단계이니 워킹 노트를 중점으로 파악해줘\./i, "")
    .replace(/\s*그리고 해당 채팅에서 매 채팅마다 항상 옵시디언 메모용 현재 상태 한 줄 요약을 적어줘\./i, "")
    .replace(/\s*추가로\s+BS를\s+한글로\s+번역해서[\s\S]*?링크해줘\./i, "")
    .trim();
  const instructions = [
    "",
    "분석 요청:",
    types.length
      ? `- 첨부되었거나 아래 경로로 제공된 ${types.join(", ")} 문서를 분석해 주세요.`
      : "- 현재 확인된 첨부 문서가 없으므로 이전 단계로 판단하고 ServiceNow Working Notes를 중점적으로 파악해 주세요.",
    "- 문서 일부가 없거나 접근할 수 없다면 확인 가능한 문서와 ServiceNow Working Notes를 우선 분석하고, 꼭 필요한 파일만 사용자에게 첨부를 요청하세요.",
    "- 이 채팅의 매 답변 마지막에는 Obsidian 메모용 ‘현재 상태 한 줄 요약’을 항상 작성해 주세요."
  ];
  if (types.includes("BS")) {
    instructions.push(
      hasBsTranslation
        ? "- 기존 BS-한글 번역본을 원본 BS와 페이지 단위로 대조하세요. Markdown/`.docx.md` 요약본이거나, 원본에 있는 표·이미지·스크린샷·도표가 빠졌거나, 원문이 과도하게 축약됐다면 완료본으로 인정하지 말고 아래 PDF 기준으로 다시 만드세요."
        : "- BS를 한국어로 번역한 별도 문서를 만들어 주세요. 로컬 파일 수정이 가능한 환경이라면 파일명을 ‘<티켓번호> BS-한글 - <원래제목>.pdf’ 형식으로 assets 폴더에 저장하고 티켓 노트의 ‘BS-한글’ 필드에 PDF를 링크하세요. 로컬 파일 수정이 불가능한 채팅 AI라면 사용자가 저장할 수 있는 번역 결과와 원본 시각자료 보존 방법을 제공하세요.",
      "- BS-한글은 요약문이 아니라 시각 문서 번역본입니다. 원본 전체 페이지를 읽고 표·이미지·스크린샷·도표·캡션·각주·링크와 섹션 순서를 보존한 한국어 PDF로 만드세요. 사용자가 명시하지 않는 한 Markdown, `.docx.md`, 텍스트 요약을 최종 산출물로 만들지 마세요.",
      "- 직접 원문 위에 번역하기 어렵다면 읽기 좋은 새 한국어 PDF로 재구성하되, 원본의 모든 시각자료를 관련 번역 문맥 옆에 포함하세요. 분석·리스크·ITO 의견은 번역 본문을 대체하지 말고 별도 부록으로 구분하세요.",
      "- 번역은 문장별 직역이 아니라 OPUS/eBooking 업무 문맥에 맞는 자연스러운 한국어로 작성하세요. 같은 용어는 문서 전체에서 동일하게 번역하고, 화면명·필드명·메시지·코드·수치·비교 연산자·조건 분기는 원문과 정확히 일치시킨 뒤 필요한 경우 원문을 괄호로 병기하세요.",
      "- 원문에 없는 결론, 기대효과, 위험, 화면 존재 여부 또는 '이미지가 없다' 같은 판단을 번역 본문에 새로 만들지 마세요. 원본 양식의 안내 문구와 실제 요구사항을 구분하고, 빈 페이지나 빈 항목은 임의 내용으로 채우지 마세요.",
      "- 최종 검수에서는 (1) 모든 요구사항과 조건/예외의 의미 정확성, (2) 용어 일관성, (3) 자연스러운 한국어, (4) 원본 시각자료와의 대응, (5) 원문에 없는 내용의 추가 여부를 별도로 확인하세요. 하나라도 충족하지 못하면 완료로 보고하지 말고 수정하세요.",
      "- 완료 전 결과 PDF의 모든 페이지를 렌더링해 육안 검수하고 원본과 페이지 단위로 비교하여 누락된 표·이미지·요구사항, 잘림, 겹침, 깨진 한글이 없는지 확인하세요."
    );
  }
  return `${next}\n${instructions.join("\n")}`.trim();
}

function classifyPromptDocuments(documentValues, failures = {}) {
  const types = ["BS", "FS", "DS", "UT"];
  return {
    availableTypes: types.filter((type) => Boolean(documentValues?.[type]?.local)),
    inaccessibleTypes: types.filter((type) =>
      Boolean(documentValues?.[type]?.link) && !documentValues?.[type]?.local
    ),
    failures: Object.fromEntries(types
      .filter((type) => failures?.[type])
      .map((type) => [type, String(failures[type])]))
  };
}

function repairTemplatePlaceholders(template) {
  let next = String(template || "");
  const repairNestedPlaceholder = (field, placeholder) => {
    const pattern = new RegExp(
      `^${field}:\\s*\\r?\\n[ \\t]+["']?\\{\\s*${placeholder}\\s*\\}["']?:\\s*$`,
      "gmi"
    );
    next = next.replace(pattern, `${field}: "{{${placeholder}}}"`);
  };
  repairNestedPlaceholder("id", "ticketId");
  repairNestedPlaceholder("category", "category");
  repairNestedPlaceholder("created", "now");
  repairNestedPlaceholder("updated", "now");
  return next.replace(/\{\{\s*(ticketId|category|now|parentName)\s*\}\}/g, "{{$1}}");
}

function normalizedHeadingText(value) {
  return String(value || "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function matchTodoHeading(line) {
  const match = String(line || "").match(/^(#{1,6})\s+(.+)$/);
  return match && normalizedHeadingText(match[2]).includes("todo") ? match : null;
}

function appendEntryToMarkdownSection(markdown, headingText, entry) {
  const lines = String(markdown || "").split(/\r?\n/);
  const target = normalizedHeadingText(headingText);
  let headingIndex = -1;
  let headingLevel = 2;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (!match || !normalizedHeadingText(match[2]).includes(target)) continue;
    headingIndex = index;
    headingLevel = match[1].length;
    break;
  }
  if (headingIndex < 0) return `${String(markdown || "").trimEnd()}\n\n## ${headingText}\n\n${entry}\n`;
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    const match = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (match && match[1].length <= headingLevel) { end = index; break; }
  }
  while (end > headingIndex + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, entry);
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

function ensureSectionActionBlock(markdown, ticketId, headingText, language) {
  const source = String(markdown || "");
  if (new RegExp(`\`\`\`${language}\\b`).test(source)) return source;
  const lines = source.split(/\r?\n/);
  const target = normalizedHeadingText(headingText);
  const block = [
    `\`\`\`${language}`,
    `ticket: ${ticketId}`,
    "\`\`\`"
  ];
  const headingIndex = lines.findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    return match && normalizedHeadingText(match[2]).includes(target);
  });
  if (headingIndex < 0) {
    return `${source.trimEnd()}\n\n## ${headingText}\n\n${block.join("\n")}\n`;
  }
  lines.splice(headingIndex + 1, 0, "", ...block, "");
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

class StateModal extends SuggestModal {
  constructor(app, states, onChoose) {
    super(app);
    this.states = states;
    this.onChoose = onChoose;
    this.setPlaceholder("ServiceNow 상태를 선택하세요");
  }
  getSuggestions(query) {
    const normalized = String(query || "").toLowerCase();
    return this.states.filter((state) => state.toLowerCase().includes(normalized));
  }
  renderSuggestion(state, el) { el.setText(state); }
  onChooseSuggestion(state) { this.onChoose(state); }
}

class NewTicketModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText("새 CR/SR 티켓 노트 만들기");
    this.contentEl.createEl("p", { text: "티켓 번호를 입력하면 표준 폴더·원본 노트·워킹노트를 자동 생성합니다." });
    const input = this.contentEl.createEl("input", { type: "text", placeholder: "예: CR0000000 또는 SR0000000" });
    input.style.width = "100%";
    input.style.marginBottom = "16px";
    input.addEventListener("input", () => {
      const cleaned = input.value.replace(/\s+/g, "").toUpperCase();
      if (input.value !== cleaned) input.value = cleaned;
    });
    const submit = () => {
      const ticketId = normalizeTicketId(input.value);
      if (!ticketId || !/^(CR|SR)/.test(ticketId)) return new Notice("올바른 CR/SR 티켓 번호를 입력하세요.");
      this.close();
      this.onSubmit(ticketId);
    };
    const button = this.contentEl.createEl("button", { text: "티켓 노트 만들기", cls: "mod-cta" });
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
    window.setTimeout(() => input.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmActionModal extends Modal {
  constructor(app, title, message, onConfirm, confirmText = "확인하고 이동", failureLabel = "처리") {
    super(app);
    this.modalTitle = title;
    this.message = message;
    this.onConfirm = onConfirm;
    this.confirmText = confirmText;
    this.failureLabel = failureLabel;
  }
  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText(this.modalTitle);
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: this.confirmText, cls: "mod-cta" });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(`${this.failureLabel} 실패: ${error.message || error}`, 9000);
        confirm.disabled = false;
      }
    });
  }
  onClose() { this.contentEl.empty(); }
}

class StatusGuideModal extends Modal {
  constructor(app, plugin, ticketId, category, status, guide) {
    super(app);
    this.plugin = plugin;
    this.ticketId = ticketId;
    this.category = category;
    this.status = status;
    this.guide = guide;
  }

  onOpen() {
    this.modalEl.addClass("clt-status-guide-modal");
    this.contentEl.empty();
    this.titleEl.setText(`${this.ticketId} 현재 상태 업무 가이드`);
    const heading = this.contentEl.createDiv({ cls: "clt-status-guide-heading" });
    heading.createSpan({ cls: `clt-status-guide-category ${this.category.toLowerCase()}`, text: this.category });
    heading.createEl("strong", { text: this.status || "상태 미확인" });

    if (!this.guide) {
      this.contentEl.createDiv({
        cls: "clt-status-guide-empty",
        text: `${this.category}의 '${this.status || "미확인"}' 상태에 등록된 업무 가이드가 없습니다.`
      });
    } else {
      this.contentEl.createDiv({ cls: "clt-status-guide-meaning", text: this.guide.meaning });
      const overview = this.contentEl.createDiv({ cls: "clt-status-guide-overview" });
      [
        ["일반적인 다음 단계", this.guide.next],
        ["주 담당", this.guide.owner],
        ["SLA / TAT", this.guide.target]
      ].filter(([, value]) => value).forEach(([label, value]) => {
        const card = overview.createDiv({ cls: "clt-status-guide-overview-card" });
        card.createSpan({ text: label });
        card.createEl("strong", { text: value });
      });
      this.contentEl.createEl("h4", { text: "현재 단계에서 확인할 일" });
      const checklist = this.contentEl.createEl("ul", { cls: "clt-status-guide-checklist" });
      for (const action of this.guide.actions || []) {
        const item = checklist.createEl("li");
        item.createSpan({ cls: "clt-status-guide-check", text: "☐" });
        item.createSpan({ text: action });
      }
      if (this.guide.alert) {
        this.contentEl.createDiv({ cls: "clt-status-guide-alert", text: this.guide.alert });
      }
      const workNoteTemplates = Array.isArray(this.guide.workNoteTemplates)
        ? this.guide.workNoteTemplates.filter((template) => String(template?.content || "").trim())
        : [];
      if (workNoteTemplates.length) {
        this.contentEl.createEl("h4", { text: "Working Note 템플릿" });
        const templateList = this.contentEl.createDiv({ cls: "clt-status-guide-templates" });
        for (const [index, template] of workNoteTemplates.entries()) {
          const card = templateList.createDiv({ cls: "clt-status-guide-template" });
          const toolbar = card.createDiv({ cls: "clt-status-guide-template-toolbar" });
          toolbar.createEl("strong", { text: String(template.title || `템플릿 ${index + 1}`) });
          const copyTemplate = toolbar.createEl("button", { text: "문구 복사" });
          const content = String(template.content || "").trim();
          copyTemplate.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(content);
              new Notice(`${String(template.title || "Working Note")} 문구를 복사했습니다.`);
            } catch (error) {
              new Notice(`Working Note 문구 복사 실패: ${error.message || error}`, 8000);
            }
          });
          card.createEl("pre", { text: content });
          if (template.note) card.createDiv({ cls: "clt-status-guide-template-note", text: String(template.note) });
        }
      }
    }

    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    if (this.guide) {
      const copy = actions.createEl("button", { text: "체크리스트 복사" });
      copy.addEventListener("click", async () => {
        const lines = [
          `${this.ticketId} | ${this.category} | ${this.status}`,
          `다음 단계: ${this.guide.next || "미정"}`,
          `주 담당: ${this.guide.owner || "미정"}`,
          ...(this.guide.target ? [`SLA/TAT: ${this.guide.target}`] : []),
          "",
          ...(this.guide.actions || []).map((action) => `- [ ] ${action}`),
          ...(this.guide.alert ? ["", `주의: ${this.guide.alert}`] : [])
        ];
        try {
          await navigator.clipboard.writeText(lines.join("\n"));
          new Notice("현재 상태 업무 체크리스트를 복사했습니다.");
        } catch (error) {
          new Notice(`체크리스트 복사 실패: ${error.message || error}`, 8000);
        }
      });
    }
    const fullGuideFile = this.plugin.statusGuideFile(this.category);
    if (fullGuideFile) {
      const fullGuide = actions.createEl("button", { text: `${this.category} 전체 가이드 열기` });
      fullGuide.addEventListener("click", () => this.plugin.openStatusGuideNote(this.category));
    }
    const close = actions.createEl("button", { text: "닫기", cls: "mod-cta" });
    close.addEventListener("click", () => this.close());
  }

  onClose() {
    this.modalEl.removeClass("clt-status-guide-modal");
    this.contentEl.empty();
  }
}

class TimedEntryModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }
  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText(this.options.title);
    this.contentEl.createDiv({ cls: "clt-ticket-entry-time", text: `현재 시각: ${localIsoDateTime().slice(0, 16)}` });
    const previewHost = this.contentEl.createDiv({ cls: "clt-todo-entry-form clt-worklog-markdown-form" });
    const input = createRichMarkdownEditor(this.app, this, previewHost, "", this.options.sourcePath || "", this.options.placeholder);
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const add = actions.createEl("button", { text: "추가", cls: "mod-cta" });
    const submit = async () => {
      const content = input.value.trim();
      if (!content) return new Notice(this.options.emptyMessage);
      add.disabled = true;
      add.setText("저장 중…");
      try {
        await this.options.onSubmit(content);
        this.close();
      } catch (error) {
        new Notice(`저장 실패: ${error.message || error}`, 9000);
        add.disabled = false;
        add.setText("추가");
      }
    };
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit();
    });
    window.setTimeout(() => input.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

class MeetingImportModal extends Modal {
  constructor(app, plugin, ticketId, onImported = null, allowTicketSelection = false) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.onImported = onImported;
    this.allowTicketSelection = allowTicketSelection;
  }
  onOpen() {
    this.modalEl.addClass("clt-meeting-import-modal");
    this.contentEl.empty();
    this.titleEl.setText(this.allowTicketSelection ? "새 회의록 추가" : `${this.ticketId} 새 회의록 추가`);
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: "Google Docs에서 마크다운(.md)으로 내려받아 등록하는 방식을 권장합니다. PDF는 원본 보관용으로 함께 선택할 수 있습니다."
    });
    const guide = this.contentEl.createDiv({ cls: "clt-meeting-format-guide" });
    guide.createDiv({ cls: "is-recommended", text: "권장 · Markdown — 제목, 체크박스, 링크, 스크립트 시간을 정확히 보존" });
    guide.createDiv({ text: "선택 · PDF — 보기 좋은 원본을 회의록 노트와 함께 보관" });
    const form = this.contentEl.createDiv({ cls: "clt-meeting-import-form" });
    let selectedTicketId = this.ticketId;
    if (this.allowTicketSelection) {
      const ticketLabel = form.createEl("label", { cls: "clt-meeting-ticket-select" });
      ticketLabel.createSpan({ text: "연결할 티켓" });
      const ticketSelect = ticketLabel.createEl("select");
      ticketSelect.createEl("option", { value: "", text: "티켓 없이 등록" });
      this.plugin.rootTicketFiles().map((file) => this.plugin.rootTicketIdFromFile(file)).filter(Boolean).sort().forEach((ticketId) => {
        ticketSelect.createEl("option", { value: ticketId, text: ticketId });
      });
      ticketSelect.value = selectedTicketId;
      ticketSelect.addEventListener("change", () => {
        selectedTicketId = normalizeTicketId(ticketSelect.value);
        titleInput.placeholder = selectedTicketId ? `${selectedTicketId} 회의` : "회의 제목";
      });
    }
    const fileLabel = form.createEl("label", { cls: "clt-meeting-file-drop" });
    fileLabel.createDiv({ cls: "clt-meeting-file-icon", text: "⇧" });
    fileLabel.createStrong({ text: "회의록 파일 선택" });
    fileLabel.createSpan({ text: ".md 또는 .txt 1개 + 선택 PDF 1개" });
    const fileInput = fileLabel.createEl("input", { type: "file" });
    fileInput.accept = ".md,.txt,.pdf,text/markdown,text/plain,application/pdf";
    fileInput.multiple = true;
    const selected = form.createDiv({ cls: "clt-meeting-selected-files", text: "선택된 파일 없음" });
    fileInput.addEventListener("change", () => {
      selected.empty();
      const files = [...(fileInput.files || [])];
      if (!files.length) selected.setText("선택된 파일 없음");
      else files.forEach((file) => selected.createDiv({ text: `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB` }));
    });
    const grid = form.createDiv({ cls: "clt-meeting-import-grid" });
    const titleLabel = grid.createEl("label");
    titleLabel.createSpan({ text: "회의 제목 (선택)" });
    const titleInput = titleLabel.createEl("input", { type: "text", placeholder: `${this.ticketId} 회의` });
    const dateLabel = grid.createEl("label");
    dateLabel.createSpan({ text: "회의 일시 (선택)" });
    const dateInput = dateLabel.createEl("input", { type: "datetime-local" });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "회의록 만들기", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) return new Notice("회의록 Markdown 파일을 선택해 주세요.");
      submit.disabled = true;
      submit.setText("회의록 만드는 중…");
      try {
        const note = await this.plugin.importMeetingFiles(selectedTicketId, files, {
          title: titleInput.value.trim(), meetingDate: dateInput.value
        });
        this.close();
        if (typeof this.onImported === "function") await this.onImported(note);
        await this.app.workspace.getLeaf(false).openFile(note);
        new Notice(`${selectedTicketId || "티켓 없는"} 회의록을 만들었습니다.`);
      } catch (error) {
        new Notice(`회의록 생성 실패: ${error.message || error}`, 9000);
        submit.disabled = false;
        submit.setText("회의록 만들기");
      }
    });
  }
  onClose() {
    this.modalEl.removeClass("clt-meeting-import-modal");
    this.contentEl.empty();
  }
}

class DriveMeetingCandidateModal extends Modal {
  constructor(app, plugin, ticketId, onImported = null) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.onImported = onImported;
    this.selectedIds = new Set();
  }

  async onOpen() {
    this.modalEl.addClass("clt-meeting-drive-modal");
    this.titleEl.setText(`${this.ticketId} Google Drive 회의록 가져오기`);
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: `파일명에 '${this.ticketId}'와 'Gemini가 작성한 회의록'이 모두 포함된 Google Docs만 검색합니다.`
    });
    const searchBar = this.contentEl.createDiv({ cls: "clt-meeting-drive-search" });
    const searchInput = searchBar.createEl("input", { type: "search", placeholder: "Google Drive 파일 제목 직접 검색" });
    const searchButton = searchBar.createEl("button", { text: "직접 검색" });
    const resetButton = searchBar.createEl("button", { text: "자동 검색" });
    this.resultsEl = this.contentEl.createDiv({ cls: "clt-meeting-drive-results" });
    const runSearch = async (query = "") => {
      this.selectedIds.clear();
      this.resultsEl.empty();
      const loading = this.resultsEl.createDiv({ cls: "clt-meeting-empty", text: query ? `'${query}' 검색 중…` : "Google Drive에서 회의록을 찾는 중…" });
      searchButton.disabled = true;
      resetButton.disabled = true;
      try {
        const candidates = await this.plugin.searchGoogleDriveMeetingDocuments(this.ticketId, query);
        loading.remove();
        this.renderCandidates(candidates, Boolean(query));
      } catch (error) {
        console.error(`[ServiceNow Manage] ${this.ticketId} Drive 회의록 후보 표시 실패`, error);
        loading.setText(`회의록 검색 실패: ${error.message || error}`);
      } finally {
        searchButton.disabled = false;
        resetButton.disabled = false;
      }
    };
    searchButton.addEventListener("click", () => {
      const query = searchInput.value.trim();
      if (!query) return new Notice("검색할 Google Drive 파일 제목을 입력해 주세요.");
      void runSearch(query);
    });
    resetButton.addEventListener("click", () => { searchInput.value = ""; void runSearch(); });
    searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchButton.click(); } });
    try {
      await runSearch();
    } catch (error) {
      console.error(`[ServiceNow Manage] ${this.ticketId} Drive 회의록 후보 표시 실패`, error);
    }
  }

  renderCandidates(candidates, manualSearch = false) {
    const imported = new Set(this.plugin.listTicketMeetings(this.ticketId).map((meeting) => meeting.sourceDriveId).filter(Boolean));
    const list = this.resultsEl.createDiv({ cls: "clt-meeting-drive-candidates" });
    if (!candidates.length) {
      list.createDiv({ cls: "clt-meeting-empty", text: manualSearch ? "입력한 제목과 일치하는 Google Docs를 찾지 못했습니다." : "조건에 맞는 Gemini 회의록을 찾지 못했습니다." });
    }
    for (const candidate of candidates) {
      const row = list.createEl("label", { cls: `clt-meeting-drive-candidate${imported.has(candidate.id) ? " is-imported" : ""}` });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.disabled = imported.has(candidate.id);
      const body = row.createSpan({ cls: "clt-meeting-drive-candidate-body" });
      const heading = body.createSpan({ cls: "clt-meeting-drive-candidate-heading" });
      heading.createSpan({ cls: "clt-meeting-drive-candidate-name", text: String(candidate.name || "이름 없는 Google Docs") });
      if (imported.has(candidate.id)) heading.createSpan({ cls: "clt-meeting-type-badge is-imported", text: "추가됨" });
      body.createSpan({
        cls: "clt-meeting-drive-candidate-meta",
        text: `회의 일시 ${String(candidate.meetingDate || "확인 불가").replace("T", " ")} · 수정 ${candidate.modifiedTime || "확인 불가"}${candidate.owner ? ` · ${candidate.owner}` : ""}`
      });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedIds.add(candidate.id);
        else this.selectedIds.delete(candidate.id);
      });
      row.dataset.candidateId = candidate.id;
    }
    const actions = this.resultsEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "선택한 회의록 추가", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      const selected = candidates.filter((candidate) => this.selectedIds.has(candidate.id));
      if (!selected.length) return new Notice("추가할 회의록을 선택해 주세요.");
      submit.disabled = true;
      submit.setText("회의록 가져오는 중…");
      try {
        let importedCount = 0;
        const warnings = [];
        for (const candidate of selected) {
          const result = await this.plugin.importGoogleDriveMeeting(this.ticketId, candidate);
          if (result?.note) importedCount += 1;
          warnings.push(...(result?.warnings || []));
        }
        if (typeof this.onImported === "function") await this.onImported();
        this.close();
        new Notice(`${this.ticketId} 회의록 ${importedCount}건을 추가했습니다.${warnings.length ? `\n${warnings.join("\n")}` : ""}`, 9000);
      } catch (error) {
        new Notice(`회의록 가져오기 실패: ${error.message || error}`, 9000);
        submit.disabled = false;
        submit.setText("선택한 회의록 추가");
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-meeting-drive-modal");
    this.contentEl.empty();
  }
}

class GlobalDriveMeetingTicketModal extends Modal {
  constructor(app, plugin, onImported = null) {
    super(app);
    this.plugin = plugin;
    this.onImported = onImported;
  }
  onOpen() {
    this.titleEl.setText("Drive 회의록을 가져올 티켓 선택");
    this.contentEl.createDiv({ cls: "clt-meeting-import-lead", text: "Drive 검색은 회의 제목의 티켓 번호를 기준으로 하므로 연결할 CR/SR을 먼저 선택해 주세요." });
    const select = this.contentEl.createEl("select");
    select.style.width = "100%";
    this.plugin.rootTicketFiles().map((file) => this.plugin.rootTicketIdFromFile(file)).filter(Boolean).sort().forEach((ticketId) => {
      select.createEl("option", { value: ticketId, text: ticketId });
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const next = actions.createEl("button", { text: "Drive 검색", cls: "mod-cta" });
    next.addEventListener("click", () => {
      const ticketId = normalizeTicketId(select.value);
      if (!ticketId) return new Notice("티켓을 선택해 주세요.");
      this.close();
      new DriveMeetingCandidateModal(this.app, this.plugin, ticketId, this.onImported).open();
    });
  }
  onClose() { this.contentEl.empty(); }
}

class MeetingAnalysisPromptModal extends Modal {
  constructor(app, plugin, ticketId) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
  }

  onOpen() {
    this.modalEl.addClass("clt-meeting-analysis-modal");
    this.titleEl.setText(`${this.ticketId} AI 회의록 분석`);
    const allMeetings = this.plugin.listTicketMeetings(this.ticketId, "asc");
    const meetings = allMeetings.filter((meeting) => meeting.kind !== "analysis");
    const baseline = this.plugin.latestMeetingAnalysis(this.ticketId);
    let useBaseline = Boolean(baseline);
    this.contentEl.createDiv({
      cls: "clt-meeting-import-lead",
      text: "분석에 포함할 회의록을 선택하세요. 기본적으로 전체 회의록이 선택됩니다."
    });
    const list = this.contentEl.createDiv({ cls: "clt-meeting-analysis-picker" });
    const selectedPaths = new Set(meetings.map((meeting) => meeting.file.path));
    for (const meeting of meetings) {
      const row = list.createEl("label", { cls: "clt-meeting-analysis-option" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      const body = row.createSpan({ cls: "clt-meeting-drive-candidate-body" });
      const name = body.createSpan({ cls: "clt-meeting-drive-candidate-name", text: meeting.title });
      if (baseline && this.plugin.meetingCoveredByAnalysis(meeting, baseline)) {
        name.createSpan({ cls: "clt-meeting-type-badge is-analysis", text: "이미 분석됨" });
      }
      body.createSpan({ cls: "clt-meeting-drive-candidate-meta", text: String(meeting.meetingDate || "일시 미지정").replace("T", " ") });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedPaths.add(meeting.file.path);
        else selectedPaths.delete(meeting.file.path);
      });
    }
    if (!meetings.length) list.createDiv({ cls: "clt-meeting-empty", text: "분석할 Gemini 회의록이 없습니다." });
    if (baseline) {
      const reuse = this.contentEl.createEl("label", { cls: "clt-meeting-analysis-reuse" });
      const checkbox = reuse.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      reuse.createSpan({ text: "기존 분석 자료를 기준으로 새 회의만 이어서 분석" });
      checkbox.addEventListener("change", () => { useBaseline = checkbox.checked; });
      this.contentEl.createDiv({
        cls: "clt-meeting-analysis-hint",
        text: "이미 분석된 회의록은 기존 분석 자료를 바탕으로 합니다. 이 옵션을 해제하면 선택한 원본 회의록 전체를 처음부터 다시 분석합니다."
      });
    }
    const details = this.contentEl.createEl("details", { cls: "clt-ai-prompt-details" });
    details.hidden = true;
    details.createEl("summary", { text: "AI 회의록 분석 프롬프트 펼치기" });
    const toolbar = details.createDiv({ cls: "clt-ai-prompt-toolbar" });
    const copy = toolbar.createEl("button", { text: "프롬프트 복사" });
    const content = details.createEl("pre", { cls: "clt-ai-prompt-content clt-meeting-analysis-prompt" });
    let prompt = "";
    copy.addEventListener("click", async () => {
      if (!prompt) return;
      await navigator.clipboard.writeText(prompt);
      new Notice("AI 회의록 분석 프롬프트를 복사했습니다.");
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const close = actions.createEl("button", { text: "닫기" });
    close.addEventListener("click", () => this.close());
    const generate = actions.createEl("button", { text: "프롬프트 생성", cls: "mod-cta" });
    generate.disabled = !meetings.length;
    generate.addEventListener("click", async () => {
      const selected = meetings.filter((meeting) => selectedPaths.has(meeting.file.path));
      if (!selected.length) return new Notice("분석할 회의록을 하나 이상 선택해 주세요.");
      generate.disabled = true;
      generate.setText("프롬프트 생성 중…");
      try {
        prompt = await this.plugin.generateMeetingAnalysisPrompt(this.ticketId, selected, { useBaseline });
        content.setText(prompt);
        details.hidden = false;
        details.open = true;
      } catch (error) {
        new Notice(`AI 회의록 분석 프롬프트 생성 실패: ${error.message || error}`, 9000);
      } finally {
        generate.disabled = false;
        generate.setText("프롬프트 생성");
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-meeting-analysis-modal");
    this.contentEl.empty();
  }
}

function extractMeetingActionItems(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+(?:\d+[.)]\s*)?(?:Action Items|할\s*일|액션\s*아이템)/i.test(line.trim()));
  if (start < 0) return [];
  const level = (lines[start].match(/^(#+)/)?.[1] || "##").length;
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (heading && heading[1].length <= level) break;
    section.push(lines[index]);
  }
  const clean = (value) => String(value || "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target, label) => label || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]/g, "")
    .trim();
  const items = [];
  const tableLines = section.filter((line) => /^\s*\|.*\|\s*$/.test(line));
  if (tableLines.length >= 2) {
    const rows = tableLines.map((line) => line.trim().slice(1, -1).split("|").map(clean));
    const headers = rows[0].map((value) => value.toLowerCase());
    const actionIndex = Math.max(0, headers.findIndex((value) => /할\s*일|action|task|내용/.test(value)));
    const ownerIndex = headers.findIndex((value) => /담당|owner|assignee/.test(value));
    const dueIndex = headers.findIndex((value) => /목표|기한|due|date/.test(value));
    for (const row of rows.slice(2)) {
      const title = clean(row[actionIndex]);
      if (!title || /^[-: ]+$/.test(title)) continue;
      items.push({ title, owner: ownerIndex >= 0 ? clean(row[ownerIndex]) : "", dueDate: dueIndex >= 0 ? clean(row[dueIndex]).match(/\d{4}-\d{2}-\d{2}/)?.[0] || "" : "" });
    }
  }
  if (!items.length) {
    for (const line of section) {
      const match = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.+?)\s*$/);
      if (match) items.push({ title: clean(match[1]), owner: "", dueDate: "" });
    }
  }
  return items.filter((item) => item.title);
}

class MeetingActionItemsModal extends Modal {
  constructor(app, plugin, ticketId, items) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.items = items;
  }

  onOpen() {
    this.modalEl.addClass("clt-meeting-action-modal");
    this.titleEl.setText(`${this.ticketId} Action Items를 To-Do로 만들기`);
    this.contentEl.createDiv({ cls: "clt-meeting-import-lead", text: "생성할 항목을 선택하고 목표일을 조정하세요. 모든 To-Do는 진행 전으로 등록됩니다." });
    const today = localIsoDateTime().slice(0, 10);
    const rows = this.items.map((item) => ({ ...item, selected: true, dueDate: item.dueDate || today }));
    const toolbar = this.contentEl.createDiv({ cls: "clt-meeting-action-toolbar" });
    const toggleAll = toolbar.createEl("input", { type: "checkbox", attr: { "aria-label": "전체 선택" } });
    toggleAll.checked = true;
    toolbar.createSpan({ text: "전체 선택" });
    const list = this.contentEl.createDiv({ cls: "clt-meeting-action-list" });
    const checkboxes = [];
    rows.forEach((item) => {
      const row = list.createDiv({ cls: "clt-meeting-action-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      checkboxes.push(checkbox);
      const body = row.createDiv({ cls: "clt-meeting-action-body" });
      body.createDiv({ cls: "clt-meeting-action-title", text: item.title });
      if (item.owner) body.createDiv({ cls: "clt-meeting-action-owner", text: `담당: ${item.owner}` });
      const date = row.createEl("input", { type: "date", attr: { "aria-label": `${item.title} 목표일` } });
      date.value = item.dueDate;
      checkbox.addEventListener("change", () => {
        item.selected = checkbox.checked;
        toggleAll.checked = checkboxes.every((box) => box.checked);
        toggleAll.indeterminate = !toggleAll.checked && checkboxes.some((box) => box.checked);
      });
      date.addEventListener("change", () => { item.dueDate = date.value || today; });
    });
    toggleAll.addEventListener("change", () => {
      rows.forEach((item, index) => { item.selected = toggleAll.checked; checkboxes[index].checked = toggleAll.checked; });
      toggleAll.indeterminate = false;
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    actions.createEl("button", { text: "취소" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: "일괄 생성", cls: "mod-cta" });
    create.addEventListener("click", async () => {
      const selected = rows.filter((item) => item.selected);
      if (!selected.length) return new Notice("생성할 Action Item을 선택해 주세요.");
      create.disabled = true;
      create.setText("생성 중…");
      try {
        for (const item of selected) {
          const details = item.owner ? `회의 Action Item · 담당: ${item.owner}` : "회의 Action Item";
          await this.plugin.addTodoToTicket(this.ticketId, item.title, item.dueDate || today, "pending", details);
        }
        new Notice(`${this.ticketId}에 진행 전 To-Do ${selected.length}건을 만들었습니다.`);
        this.close();
      } catch (error) {
        new Notice(`Action Items 일괄 생성 실패: ${error.message || error}`, 9000);
        create.disabled = false;
        create.setText("일괄 생성");
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-meeting-action-modal");
    this.contentEl.empty();
  }
}

class MeetingListModal extends Modal {
  constructor(app, plugin, ticketId) {
    super(app);
    this.plugin = plugin;
    this.ticketId = normalizeTicketId(ticketId);
    this.sortDirection = "desc";
  }
  async onOpen() {
    this.modalEl.addClass("clt-meeting-list-modal");
    this.titleEl.setText(`${this.ticketId} 회의록`);
    const refreshIfRelevant = (file, oldPath = "") => {
      const folder = `${this.plugin.ticketMeetingsFolder(this.ticketId)}/`;
      if (!String(file?.path || "").startsWith(folder) && !String(oldPath || "").startsWith(folder)) return;
      window.setTimeout(() => this.render(), 120);
    };
    this.registerEvent(this.app.vault.on("create", refreshIfRelevant));
    this.registerEvent(this.app.vault.on("delete", refreshIfRelevant));
    this.registerEvent(this.app.vault.on("rename", refreshIfRelevant));
    this.registerEvent(this.app.vault.on("modify", refreshIfRelevant));
    this.registerEvent(this.app.metadataCache.on("changed", refreshIfRelevant));
    await this.render();
  }
  async render() {
    this.contentEl.empty();
    const toolbar = this.contentEl.createDiv({ cls: "clt-meeting-list-toolbar" });
    const count = toolbar.createDiv({ cls: "clt-meeting-list-count" });
    const actions = toolbar.createDiv({ cls: "clt-meeting-list-actions" });
    const sort = actions.createEl("button", { text: this.sortDirection === "desc" ? "최신순 ↓" : "오래된순 ↑" });
    sort.addEventListener("click", async () => {
      this.sortDirection = this.sortDirection === "desc" ? "asc" : "desc";
      await this.render();
    });
    const drive = actions.createEl("button", { text: "Drive에서 가져오기" });
    drive.addEventListener("click", () => new DriveMeetingCandidateModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const refresh = actions.createEl("button", { text: "새로고침", attr: { title: "회의록 목록 새로고침" } });
    refresh.addEventListener("click", () => this.render());
    const add = actions.createEl("button", { text: "＋ 파일로 추가", cls: "mod-cta" });
    add.addEventListener("click", () => new MeetingImportModal(this.app, this.plugin, this.ticketId, () => this.render()).open());
    const list = this.contentEl.createDiv({ cls: "clt-meeting-list" });
    const meetings = this.plugin.listTicketMeetings(this.ticketId, this.sortDirection);
    count.setText(`${meetings.length}개의 회의 기록`);
    list.dataset.sortDirection = this.sortDirection;
    list.addEventListener("clt-meeting-deleted", () => this.render());
    this.plugin.renderMeetingCards(list, meetings, { emptyText: "아직 등록된 회의록이 없습니다." });
  }
  onClose() {
    this.modalEl.removeClass("clt-meeting-list-modal");
    this.contentEl.empty();
  }
}

class TodoEntryModal extends Modal {
  constructor(app, plugin, preselectedTicketId = "", onSaved = null, preselectedStatus = "pending") {
    super(app);
    this.plugin = plugin;
    this.preselectedTicketId = normalizeTicketId(preselectedTicketId);
    this.onSaved = onSaved;
    this.preselectedStatus = ["pending", "in-progress", "done"].includes(preselectedStatus)
      ? preselectedStatus
      : "pending";
    this.selectedTicketId = "";
  }

  onOpen() {
    this.contentEl.empty();
    this.modalEl.addClass("clt-todo-entry-modal");
    this.titleEl.setText("☑ 새 To-Do 추가");

    const tickets = this.plugin.rootTicketFiles()
      .map((file) => {
        const ticketId = this.plugin.rootTicketIdFromFile(file);
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const ticket = this.plugin.data.tickets[ticketId] || {};
        return {
          ticketId,
          file,
          status: String(frontmatter.status || ticket.state || ""),
          title: String(ticket.shortDescription || frontmatter["Short Description"] || "")
        };
      })
      .filter((item) => item.ticketId)
      .sort((left, right) => left.ticketId.localeCompare(right.ticketId, "ko", { numeric: true }));

    if (tickets.some((item) => item.ticketId === this.preselectedTicketId)) {
      this.selectedTicketId = this.preselectedTicketId;
    }

    const ticketSection = this.contentEl.createDiv({ cls: "clt-todo-ticket-picker" });
    const ticketHeaderRow = ticketSection.createDiv({ cls: "clt-todo-ticket-header-row" });
    const ticketHeaderLabel = ticketHeaderRow.createDiv({ cls: "clt-todo-field-label", text: "티켓 · 필수" });
    const noTicketLabel = ticketHeaderRow.createEl("label", { cls: "clt-todo-no-ticket-toggle" });
    const noTicketCheckbox = noTicketLabel.createEl("input", { type: "checkbox" });
    noTicketLabel.createSpan({ text: "티켓 선택 안 함" });

    const search = ticketSection.createEl("input", {
      type: "search",
      cls: "clt-todo-ticket-search",
      placeholder: "티켓 번호 또는 제목 검색 · 예: 12"
    });
    if (this.selectedTicketId) search.value = this.selectedTicketId;
    const resultInfo = ticketSection.createDiv({ cls: "clt-todo-ticket-result-info" });
    const results = ticketSection.createDiv({ cls: "clt-todo-ticket-results" });

    const renderTickets = () => {
      if (noTicketCheckbox.checked) {
        ticketSection.addClass("is-disabled");
        ticketHeaderLabel.setText("티켓 · 선택 안 함");
        search.disabled = true;
        results.style.display = "none";
        resultInfo.setText("연결된 티켓 없이 일반 To-Do로 등록됩니다.");
        return;
      }
      ticketSection.removeClass("is-disabled");
      ticketHeaderLabel.setText("티켓 · 필수");
      search.disabled = false;
      results.style.display = "";
      const query = search.value.trim().toLowerCase();
      const filtered = tickets.filter((item) =>
        !query || [item.ticketId, item.title, item.status]
          .some((value) => String(value || "").toLowerCase().includes(query))
      );
      if (filtered.length === 1 && !this.selectedTicketId) this.selectedTicketId = filtered[0].ticketId;
      else if (!filtered.some((item) => item.ticketId === this.selectedTicketId)) this.selectedTicketId = "";
      results.empty();
      resultInfo.setText(`${filtered.length}개 티켓${this.selectedTicketId ? ` · ${this.selectedTicketId} 선택됨` : ""}`);
      if (!filtered.length) {
        results.createDiv({ cls: "clt-todo-ticket-empty", text: "검색되는 티켓이 없습니다." });
        return;
      }
      filtered.forEach((item) => {
        const button = results.createEl("button", { cls: "clt-todo-ticket-option" });
        if (item.ticketId === this.selectedTicketId) button.addClass("selected");
        const heading = button.createDiv({ cls: "clt-todo-ticket-option-heading" });
        heading.createSpan({ cls: "clt-todo-ticket-option-id", text: item.ticketId });
        if (item.status) heading.createSpan({ cls: "clt-todo-ticket-option-status", text: item.status });
        if (item.title) button.createDiv({ cls: "clt-todo-ticket-option-title", text: item.title });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          this.selectedTicketId = item.ticketId;
          renderTickets();
        });
      });
    };
    noTicketCheckbox.addEventListener("change", () => {
      if (noTicketCheckbox.checked) this.selectedTicketId = "";
      renderTickets();
    });
    search.addEventListener("input", renderTickets);
    renderTickets();

    const form = this.contentEl.createDiv({ cls: "clt-todo-entry-form" });
    const contentLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    contentLabel.createSpan({ cls: "clt-todo-field-label", text: "제목 · 필수" });
    const content = contentLabel.createEl("textarea", {
      cls: "clt-ticket-entry-input",
      placeholder: "할 일의 제목을 입력하세요."
    });
    const detailLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    detailLabel.createSpan({ cls: "clt-todo-field-label", text: "상세 내용 · 선택" });
    const detail = createRichMarkdownEditor(this.app, this, detailLabel, "", "", "배경, 확인할 내용, 참고 링크 등을 입력하세요.");
    const row = form.createDiv({ cls: "clt-todo-entry-row" });
    const dueLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    dueLabel.createSpan({ cls: "clt-todo-field-label", text: "완료 예정일 · 선택" });
    const dueFields = dueLabel.createDiv({ cls: "clt-todo-due-fields" });
    const dueDate = dueFields.createEl("input", { type: "date", attr: { "aria-label": "완료 예정일" } });
    const dueTime = dueFields.createEl("input", { type: "time", attr: { "aria-label": "완료 예정 시각" } });
    dueTime.disabled = true;
    dueDate.addEventListener("change", () => {
      dueTime.disabled = !dueDate.value;
      if (dueDate.value && !dueTime.value) dueTime.value = localIsoDateTime().slice(11, 16);
      if (!dueDate.value) dueTime.value = "";
    });
    const statusLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    statusLabel.createSpan({ cls: "clt-todo-field-label", text: "시작 상태" });
    const status = statusLabel.createEl("select");
    [
      ["pending", "○ 진행 전"],
      ["in-progress", "◐ 진행 중"],
      ["done", "✓ 완료"]
    ].forEach(([value, label]) => {
      const option = status.createEl("option", { value, text: label });
      option.value = value;
      option.selected = value === this.preselectedStatus;
    });

    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => this.close());
    const add = actions.createEl("button", { text: "To-Do 추가", cls: "mod-cta" });
    const submit = async () => {
      const isStandalone = noTicketCheckbox.checked || !this.selectedTicketId;
      if (!isStandalone && !this.selectedTicketId) {
        search.focus();
        return new Notice("티켓을 선택하거나 '티켓 선택 안 함'을 체크해 주세요.");
      }
      if (!content.value.trim()) {
        content.focus();
        return new Notice("할 일을 입력해 주세요.");
      }
      add.disabled = true;
      add.setText("추가 중…");
      try {
        if (isStandalone) {
          await this.plugin.addTodoToGeneral(
            content.value,
            composeTodoDueValue(dueDate.value, dueTime.value),
            status.value,
            detail.value
          );
          if (typeof this.onSaved === "function") await this.onSaved("");
          new Notice("To-Do를 추가했습니다.");
        } else {
          await this.plugin.addTodoToTicket(
            this.selectedTicketId,
            content.value,
            composeTodoDueValue(dueDate.value, dueTime.value),
            status.value,
            detail.value
          );
          if (typeof this.onSaved === "function") await this.onSaved(this.selectedTicketId);
          new Notice(`${this.selectedTicketId}에 To-Do를 추가했습니다.`);
        }
        this.close();
      } catch (error) {
        new Notice(`To-Do 추가 실패: ${error.message || error}`, 9000);
        add.disabled = false;
        add.setText("To-Do 추가");
      }
    };
    add.addEventListener("click", submit);
    content.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit();
    });
    window.setTimeout(() => this.preselectedTicketId ? content.focus() : search.focus(), 50);
  }

  onClose() {
    this.modalEl.removeClass("clt-todo-entry-modal");
    this.contentEl.empty();
  }
}

function stripCltTodoMetadata(value) {
  return String(value || "")
    .replace(/\s*<!--\s*clt-todo:(?:pending|in-progress|done)\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-due:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-completed:[^>]+?\s*-->\s*/gi, " ")
    .replace(/\s*<!--\s*clt-todo-detail:[^>]*?\s*-->\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function encodeTodoDetail(value) {
  return encodeURIComponent(String(value || "").trim());
}

function decodeTodoDetail(value) {
  try { return decodeURIComponent(String(value || "")); }
  catch (_) { return String(value || ""); }
}

function splitTodoDueValue(value) {
  const match = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/);
  return { date: match?.[1] || "", time: match?.[2] || "" };
}

function composeTodoDueValue(date, time) {
  const cleanDate = String(date || "").trim();
  const cleanTime = String(time || "").trim();
  return cleanDate ? `${cleanDate}${cleanTime ? `T${cleanTime}` : ""}` : "";
}

function formatTodoDueValue(value) {
  return String(value || "").replace("T", " ");
}

function todoVisualTone(task, nowValue = new Date()) {
  if (String(task?.status || "") === "done") return "done";
  const raw = String(task?.dueDate || "").trim();
  if (!raw) return "";
  const hasTime = raw.includes("T");
  const due = new Date(hasTime ? raw : `${raw}T23:59:59`);
  const now = new Date(nowValue);
  if (Number.isNaN(due.getTime()) || Number.isNaN(now.getTime())) return "";
  const remaining = due.getTime() - now.getTime();
  if (remaining < 0) return "overdue";
  if (remaining <= 86400000) return "urgent";
  if (remaining <= 259200000) return "soon";
  return "";
}

class ConfirmDeleteModal extends Modal {
  constructor(app, { ticketId, title, onConfirm }) {
    super(app);
    this.ticketId = ticketId;
    this.itemTitle = title;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    this.modalEl.addClass("clt-confirm-modal");
    this.titleEl.setText("To-Do 삭제");
    const panel = this.contentEl.createDiv({ cls: "clt-confirm-panel" });
    panel.createDiv({ cls: "clt-confirm-icon", text: "!" });
    const copy = panel.createDiv({ cls: "clt-confirm-copy" });
    copy.createEl("strong", { text: `${this.ticketId ? `${this.ticketId}의 ` : ""}To-Do를 삭제하시겠습니까?` });
    copy.createDiv({ cls: "clt-confirm-description", text: "삭제한 항목은 자동으로 복구되지 않습니다." });
    copy.createDiv({ cls: "clt-confirm-item", text: this.itemTitle || "(제목 없음)" });
    const actions = this.contentEl.createDiv({ cls: "clt-confirm-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    const confirm = actions.createEl("button", { text: "삭제", cls: "mod-warning" });
    cancel.addEventListener("click", () => this.close());
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        await this.onConfirm?.();
        this.close();
      } catch (error) {
        confirm.disabled = false;
        cancel.disabled = false;
        new Notice(`To-Do 삭제 실패: ${error.message || error}`, 9000);
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TodoDetailEntryModal extends Modal {
  constructor(app, plugin, task, onSaved = null) {
    super(app);
    this.plugin = plugin;
    this.task = { ...task };
    this.onSaved = onSaved;
  }

  onOpen() {
    this.modalEl.addClass("clt-todo-detail-modal");
    this.render();
  }

  renderLinkedText(container, text) {
    container.empty();
    const value = String(text || "");
    const urlPattern = /https?:\/\/[^\s<>()]+/gi;
    let offset = 0;
    for (const match of value.matchAll(urlPattern)) {
      if (match.index > offset) container.appendText(value.slice(offset, match.index));
      const url = match[0].replace(/[.,;!?]+$/, "");
      const trailing = match[0].slice(url.length);
      const link = container.createEl("a", { text: url, href: url, cls: "clt-todo-detail-link" });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        shell.openExternal(url);
      });
      if (trailing) container.appendText(trailing);
      offset = match.index + match[0].length;
    }
    if (offset < value.length) container.appendText(value.slice(offset));
  }

  render() {
    this.contentEl.empty();
    this.titleEl.empty();
    const hasTicket = Boolean(this.task.ticketId);
    const title = this.titleEl.createSpan({ cls: "clt-todo-modal-title" });
    title.createSpan({ cls: "clt-todo-modal-icon", text: "✓" });
    title.createSpan({ text: hasTicket ? `${this.task.ticketId} To-Do` : "To-Do" });

    const layout = this.contentEl.createDiv({ cls: `clt-todo-detail-layout${hasTicket ? "" : " no-ticket"}` });

    if (hasTicket) {
      const context = layout.createEl("aside", { cls: "clt-todo-ticket-context" });
      const ticket = this.plugin.data.tickets?.[this.task.ticketId];
      context.createDiv({ cls: "clt-todo-context-label", text: "SHORT DESCRIPTION" });
      context.createEl("strong", {
        cls: "clt-todo-context-title",
        text: ticket?.shortDescription || "티켓 기본정보를 갱신하면 설명이 표시됩니다."
      });
      const statusLine = context.createDiv({ cls: "clt-todo-context-status" });
      statusLine.createSpan({ text: "ServiceNow 상태" });
      statusLine.createEl("strong", { text: ticket?.state || ticket?.status || "—" });
      if (ticket?.description) {
        const description = context.createEl("details", { cls: "clt-todo-context-details" });
        description.createEl("summary", { text: "Description 펼치기" });
        description.createEl("pre", { text: ticket.description });
      }
      const translatedShort = ticket?.translations?.shortDescription?.ko || "";
      const translatedDescription = ticket?.translations?.description?.ko || "";
      if (translatedShort || translatedDescription) {
        const translation = context.createEl("details", { cls: "clt-todo-context-details" });
        translation.createEl("summary", { text: "한국어 번역 펼치기" });
        translation.createEl("pre", { text: [translatedShort, translatedDescription].filter(Boolean).join("\n\n") });
      }
    }

    const editor = layout.createDiv({ cls: "clt-todo-detail-editor" });
    const form = editor.createDiv({ cls: "clt-todo-entry-form" });
    const contentLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    contentLabel.createSpan({ cls: "clt-todo-field-label", text: "제목" });
    const content = contentLabel.createEl("textarea", { cls: "clt-ticket-entry-input" });
    content.value = this.task.text || "";
    const detailLabel = form.createEl("label", { cls: "clt-todo-entry-field" });
    detailLabel.createSpan({ cls: "clt-todo-field-label", text: "상세 내용" });
    const detail = createRichMarkdownEditor(
      this.app,
      this,
      detailLabel,
      this.task.details || "",
      this.task.filePath || "",
      "배경, 확인할 내용, 참고 링크 등을 입력하세요."
    );
    const row = form.createDiv({ cls: "clt-todo-entry-row" });
    const statusLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    statusLabel.createSpan({ cls: "clt-todo-field-label", text: "상태" });
    const status = statusLabel.createEl("select");
    [["pending", "진행 전"], ["in-progress", "진행 중"], ["done", "완료"]]
      .forEach(([value, label]) => {
        const option = status.createEl("option", { text: label });
        option.value = value;
        option.selected = value === this.task.status;
      });
    const dueLabel = row.createEl("label", { cls: "clt-todo-entry-field" });
    dueLabel.createSpan({ cls: "clt-todo-field-label", text: "완료 예정일" });
    const dueFields = dueLabel.createDiv({ cls: "clt-todo-due-fields" });
    const dueDate = dueFields.createEl("input", { type: "date", attr: { "aria-label": "완료 예정일" } });
    const dueTime = dueFields.createEl("input", { type: "time", attr: { "aria-label": "완료 예정 시각" } });
    const initialDue = splitTodoDueValue(this.task.dueDate);
    dueDate.value = initialDue.date;
    dueTime.value = initialDue.time;
    dueTime.disabled = !dueDate.value;
    dueDate.addEventListener("change", () => {
      dueTime.disabled = !dueDate.value;
      if (dueDate.value && !dueTime.value) dueTime.value = localIsoDateTime().slice(11, 16);
      if (!dueDate.value) dueTime.value = "";
    });

    const readonly = editor.createDiv({ cls: "clt-todo-readonly-grid" });
    [["등록일", this.task.dateTime || "—"], ["완료일", this.task.completedAt || "—"]]
      .forEach(([label, value]) => {
        const item = readonly.createDiv({ cls: "clt-todo-readonly-item" });
        item.createSpan({ text: label });
        item.createEl("strong", { text: value });
      });

    const actions = editor.createDiv({ cls: "clt-sn-document-actions" });
    const remove = actions.createEl("button", { text: "삭제", cls: "mod-warning clt-todo-delete-button" });
    remove.addEventListener("click", () => {
      new ConfirmDeleteModal(this.app, {
        ticketId: this.task.ticketId || "",
        title: this.task.text || "",
        onConfirm: async () => {
          await this.plugin.deleteTodoTask(this.task);
          if (typeof this.onSaved === "function") await this.onSaved({ ...this.task, deleted: true });
          new Notice(`${this.task.ticketId || "To-Do"}를 삭제했습니다.`);
          this.close();
        }
      }).open();
    });
    const copy = actions.createEl("button", { text: "내용 복사" });
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText([content.value, detail.value].filter((value) => String(value || "").trim()).join("\n\n"));
      new Notice("To-Do 내용을 복사했습니다.");
    });
    const open = actions.createEl("button", { text: "원본 티켓 열기" });
    if (!hasTicket) {
      open.disabled = true;
      open.title = "연결된 티켓이 없습니다.";
    } else {
      open.addEventListener("click", async () => {
        const file = this.plugin.rootTicketFile(this.task.ticketId);
        if (!file) return;
        this.close();
        await this.app.workspace.getLeaf(false).openFile(file);
      });
    }
    const save = actions.createEl("button", { text: "저장", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      if (!content.value.trim()) return new Notice("할 일을 입력해 주세요.");
      save.disabled = true;
      try {
        this.task = await this.plugin.updateTodoTaskDetails(this.task, {
          text: content.value,
          details: detail.value,
          dueDate: composeTodoDueValue(dueDate.value, dueTime.value),
          status: status.value
        });
        if (typeof this.onSaved === "function") await this.onSaved(this.task);
        new Notice(`${this.task.ticketId || "To-Do"}를 저장했습니다.`);
        this.close();
      } catch (error) {
        new Notice(`To-Do 저장 실패: ${error.message || error}`, 9000);
        save.disabled = false;
      }
    });
  }

  onClose() {
    this.modalEl.removeClass("clt-todo-detail-modal");
    this.contentEl.empty();
  }
}

class WorkNotesRenderChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, ticketId) {
    super(containerEl);
    this.plugin = plugin;
    this.ticketId = ticketId;
    this.state = { query: "", sort: "desc", from: "", to: "", type: "all", language: "original" };
  }

  onload() {
    this.plugin.registerView(this.ticketId, this);
    this.render();
    this.plugin.scheduleViewRefresh(this.ticketId, "work-notes");
  }

  onunload() {
    this.plugin.unregisterView(this.ticketId, this);
  }

  render() {
    const container = this.containerEl;
    container.empty();
    container.addClass("clt-sn-root");
    const ticket = this.plugin.data.tickets[this.ticketId];

    const header = container.createDiv({ cls: "clt-sn-header" });
    const headingBlock = header.createDiv({ cls: "clt-sn-heading" });
    headingBlock.createEl("h3", { text: `${this.ticketId} ServiceNow 워킹노트` });
    const statusText = ticket?.lastSyncedAt
      ? `마지막 갱신: ${ticket.lastSyncedAt}`
      : ticket?.lastError
        ? `갱신 실패: ${ticket.lastError}`
        : "ServiceNow 연결 후 갱신할 수 있습니다.";
    headingBlock.createDiv({ cls: "clt-sn-sync-status", text: statusText });

    const actions = header.createDiv({ cls: "clt-sn-actions" });
    const refresh = actions.createEl("button", { cls: "mod-cta", text: "지금 갱신" });
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      refresh.setText("갱신 중…");
      try { await this.plugin.syncTicket(this.ticketId, { notify: true }); }
      finally { refresh.disabled = false; refresh.setText("지금 갱신"); }
    });
    const open = actions.createEl("button", { text: "ServiceNow 열기" });
    open.addEventListener("click", () => this.plugin.openTicketInBrowser(this.ticketId));
    const copy = actions.createEl("button", { text: "보이는 내용 복사" });
    copy.addEventListener("click", async () => {
      copy.disabled = true;
      copy.setText("복사 중…");
      try {
        await this.copyVisibleEntries();
      } finally {
        copy.disabled = false;
        copy.setText("보이는 내용 복사");
      }
    });
    const translate = actions.createEl("button", { cls: "clt-sn-translate-button", text: "선택 언어 번역" });
    translate.addEventListener("click", async () => {
      if (this.state.language === "original") {
        new Notice("필터에서 한국어 또는 베트남어를 먼저 선택하세요.");
        return;
      }
      translate.disabled = true;
      translate.setText("번역 중…");
      try { await this.plugin.translateTicket(this.ticketId, this.state.language, { notify: true }); }
      finally { translate.disabled = false; translate.setText("선택 언어 번역"); }
    });

    if (!ticket) {
      const empty = container.createDiv({ cls: "clt-sn-empty" });
      empty.createEl("p", { text: "아직 가져온 데이터가 없습니다." });
      const connect = empty.createEl("button", { text: "ServiceNow 연결" });
      connect.addEventListener("click", () => this.plugin.connectServiceNow());
      return;
    }

    const summary = container.createDiv({ cls: "clt-sn-summary" });
    const selectedLanguage = this.state.language === "original" ? "" : this.state.language;
    const translatedShortDescription = selectedLanguage
      ? ticket.translations?.shortDescription?.[selectedLanguage] || ""
      : "";
    const translatedDescription = selectedLanguage
      ? ticket.translations?.description?.[selectedLanguage] || ""
      : "";
    const shortSection = summary.createDiv({ cls: "clt-sn-summary-section" });
    shortSection.createDiv({ cls: "clt-sn-summary-label", text: "Short description" });
    shortSection.createDiv({
      cls: `clt-sn-summary-title${translatedShortDescription ? " clt-sn-translation" : ""}`,
      text: translatedShortDescription || ticket.shortDescription || "(제목 없음)"
    });
    if (translatedShortDescription) {
      const originalShortDescription = shortSection.createEl("details", { cls: "clt-sn-original" });
      originalShortDescription.createEl("summary", { text: "Short description 원문 보기" });
      originalShortDescription.createDiv({ text: ticket.shortDescription || "(제목 없음)" });
    } else if (selectedLanguage && ticket.shortDescription) {
      shortSection.createDiv({ cls: "clt-sn-translation-missing", text: "Short description이 아직 번역되지 않았습니다." });
    }
    if (ticket.description) {
      const descriptionSection = summary.createDiv({ cls: "clt-sn-summary-section clt-sn-description-section" });
      const descriptionHeader = descriptionSection.createDiv({ cls: "clt-sn-description-header" });
      descriptionHeader.createDiv({ cls: "clt-sn-summary-label", text: "Description" });
      const toggleDescription = descriptionHeader.createEl("button", { cls: "clt-sn-collapse-button", text: "내용 펼치기" });
      const descriptionBody = descriptionSection.createDiv({ cls: "clt-sn-description-body" });
      descriptionBody.style.display = "none";
      toggleDescription.addEventListener("click", () => {
        const isOpen = descriptionBody.style.display !== "none";
        descriptionBody.style.display = isOpen ? "none" : "block";
        toggleDescription.setText(isOpen ? "내용 펼치기" : "내용 접기");
      });
      descriptionBody.createEl("pre", {
        cls: translatedDescription ? "clt-sn-translation" : "",
        text: translatedDescription || ticket.description
      });
      if (translatedDescription) {
        const originalToggle = descriptionBody.createEl("button", { cls: "clt-sn-original-button", text: "원문 보기" });
        const originalDescription = descriptionBody.createEl("pre", { cls: "clt-sn-original-content", text: ticket.description });
        originalDescription.style.display = "none";
        originalToggle.addEventListener("click", () => {
          const isOpen = originalDescription.style.display !== "none";
          originalDescription.style.display = isOpen ? "none" : "block";
          originalToggle.setText(isOpen ? "원문 보기" : "원문 닫기");
        });
      } else if (selectedLanguage) {
        descriptionBody.createDiv({ cls: "clt-sn-translation-missing", text: "Description이 아직 번역되지 않았습니다." });
      }
    }

    this.renderFilters(container, ticket.entries || []);
    this.renderEntries(container, ticket.entries || []);
  }

  renderFilters(container, allEntries) {
    const filters = container.createDiv({ cls: "clt-sn-filters" });
    const search = filters.createEl("input", { type: "search", placeholder: "워킹노트 단어 또는 작성자 검색" });
    search.value = this.state.query;
    search.addEventListener("input", () => { this.state.query = search.value; this.renderEntries(container, allEntries); });

    const sort = filters.createEl("select");
    [["desc", "최신순"], ["asc", "오래된순"]].forEach(([value, label]) => {
      const option = sort.createEl("option", { value, text: label });
      option.selected = value === this.state.sort;
    });
    sort.addEventListener("change", () => { this.state.sort = sort.value; this.renderEntries(container, allEntries); });

    const type = filters.createEl("select");
    [["all", "전체 유형"], ["Work Note", "Work Note"], ["Attachment", "Attachment"]]
      .forEach(([value, label]) => {
        const option = type.createEl("option", { value, text: label });
        option.selected = value === this.state.type;
      });
    type.addEventListener("change", () => { this.state.type = type.value; this.renderEntries(container, allEntries); });

    const language = filters.createEl("select");
    [["original", "원문"], ["ko", "한국어"], ["vi", "베트남어"]].forEach(([value, label]) => {
      const option = language.createEl("option", { value, text: label });
      option.selected = value === this.state.language;
    });
    language.addEventListener("change", () => {
      const selectedLanguage = language.value;
      this.state.language = selectedLanguage;
      this.render();
      if (selectedLanguage !== "original") {
        void this.plugin.translateTicket(this.ticketId, selectedLanguage, { notify: true });
      }
    });

    const fromWrap = filters.createDiv({ cls: "clt-sn-date-field" });
    fromWrap.createEl("span", { text: "시작일" });
    const from = fromWrap.createEl("input", { type: "date" });
    from.value = this.state.from;
    from.addEventListener("change", () => { this.state.from = from.value; this.renderEntries(container, allEntries); });

    const toWrap = filters.createDiv({ cls: "clt-sn-date-field" });
    toWrap.createEl("span", { text: "종료일" });
    const to = toWrap.createEl("input", { type: "date" });
    to.value = this.state.to;
    to.addEventListener("change", () => { this.state.to = to.value; this.renderEntries(container, allEntries); });
  }

  filteredEntries(entries) {
    const query = this.state.query.trim().toLowerCase();
    return entries
      .filter((entry) => this.state.type === "all" || entry.type === this.state.type)
      .filter((entry) => !this.state.from || entry.time.slice(0, 10) >= this.state.from)
      .filter((entry) => !this.state.to || entry.time.slice(0, 10) <= this.state.to)
      .filter((entry) => {
        const translated = this.state.language === "original" ? "" : entry.translations?.[this.state.language] || "";
        return !query || `${entry.author || ""}\n${entry.type || ""}\n${entry.content || ""}\n${translated}`.toLowerCase().includes(query);
      })
      .sort((a, b) => this.state.sort === "asc" ? a.time.localeCompare(b.time) : b.time.localeCompare(a.time));
  }

  async copyVisibleEntries() {
    const ticket = this.plugin.data.tickets[this.ticketId];
    if (!ticket) {
      new Notice("복사할 워킹노트가 없습니다. 먼저 갱신해 주세요.");
      return;
    }
    const entries = this.filteredEntries(ticket.entries || []);
    if (!entries.length) {
      new Notice("현재 화면 조건에 맞는 워킹노트가 없습니다.");
      return;
    }
    const languageLabel = this.state.language === "ko"
      ? "한국어"
      : this.state.language === "vi" ? "베트남어" : "원문";
    const selectedLanguage = this.state.language === "original" ? "" : this.state.language;
    const shortDescription = selectedLanguage
      ? ticket.translations?.shortDescription?.[selectedLanguage] || ticket.shortDescription
      : ticket.shortDescription;
    const description = selectedLanguage
      ? ticket.translations?.description?.[selectedLanguage] || ticket.description
      : ticket.description;
    const lines = [
      `# ${this.ticketId} ServiceNow 워킹노트`,
      "",
      `Short description: ${shortDescription || "(제목 없음)"}`
    ];
    if (description) lines.push("", "Description:", description);
    lines.push(
      "",
      `표시 순서: ${this.state.sort === "asc" ? "오래된순" : "최신순"}`,
      `표시 언어: ${languageLabel}`,
      `표시 건수: ${entries.length}건`,
      ""
    );
    entries.forEach((entry, index) => {
      const meta = [entry.time, entry.type, entry.author].filter(Boolean).join(" | ");
      const translated = this.state.language === "original"
        ? ""
        : entry.translations?.[this.state.language] || "";
      const content = entry.url
        ? `${entry.content || "첨부파일"}\n${entry.url}`
        : translated || entry.content || "";
      lines.push(`${index + 1}. ${meta}`, content, "");
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n").trim());
      new Notice(`현재 화면 순서대로 워킹노트 ${entries.length}건을 복사했습니다.`, 5000);
    } catch (error) {
      new Notice(`클립보드 복사 실패: ${error.message || error}`, 7000);
    }
  }

  renderEntries(container, allEntries) {
    container.querySelector(".clt-sn-results")?.remove();
    const results = container.createDiv({ cls: "clt-sn-results" });
    const entries = this.filteredEntries(allEntries);
    results.createDiv({ cls: "clt-sn-count", text: `${entries.length} / ${allEntries.length}건` });
    if (!entries.length) {
      results.createDiv({ cls: "clt-sn-empty", text: "조건에 맞는 워킹노트가 없습니다." });
      return;
    }
    entries.forEach((entry) => {
      const card = results.createDiv({ cls: `clt-sn-card clt-sn-${String(entry.type).toLowerCase().replace(/\s+/g, "-")}` });
      const meta = card.createDiv({ cls: "clt-sn-card-meta" });
      meta.createSpan({ cls: "clt-sn-time", text: entry.time });
      meta.createSpan({ cls: "clt-sn-badge", text: entry.type });
      if (entry.author) meta.createSpan({ cls: "clt-sn-author", text: entry.author });
      if (entry.url) {
        this.renderAttachment(card, entry);
      } else {
        const translated = this.state.language === "original" ? "" : entry.translations?.[this.state.language] || "";
        if (translated) {
          card.createEl("pre", { cls: "clt-sn-content clt-sn-translation", text: translated });
          const original = card.createEl("details", { cls: "clt-sn-original" });
          original.createEl("summary", { text: "원문 보기" });
          original.createEl("pre", { cls: "clt-sn-content", text: entry.content || "" });
        } else {
          card.createEl("pre", { cls: "clt-sn-content", text: entry.content || "" });
          if (this.state.language !== "original") {
            card.createDiv({ cls: "clt-sn-translation-missing", text: "아직 번역되지 않은 항목입니다." });
          }
        }
      }
    });
  }

  renderAttachment(card, entry) {
    const image = isImageAttachment(entry.content, entry.contentType);
    const video = isVideoAttachment(entry.content, entry.contentType);
    const attachmentId = serviceNowAttachmentId(entry);
    if (image && attachmentId) {
      const preview = card.createDiv({ cls: "clt-sn-attachment-preview" });
      const loading = preview.createDiv({ cls: "clt-sn-attachment-loading", text: "이미지 불러오는 중…" });
      this.plugin.attachmentImageDataUrl({ ...entry, attachmentId }).then((dataUrl) => {
        if (!preview.isConnected) return;
        loading.remove();
        preview.createEl("img", {
          attr: { src: dataUrl, alt: entry.content || "ServiceNow 첨부 이미지" }
        });
      }).catch((error) => {
        if (!preview.isConnected) return;
        loading.setText(`이미지 미리보기 실패: ${error.message || error}`);
      });
    }
    if (video && attachmentId) {
      const preview = card.createDiv({ cls: "clt-sn-attachment-preview clt-sn-video-preview" });
      const loading = preview.createDiv({ cls: "clt-sn-attachment-loading", text: "영상 준비 중…" });
      this.plugin.ensureAttachmentVideoFile(this.ticketId, { ...entry, attachmentId }).then((path) => {
        if (!preview.isConnected) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("저장된 영상 파일을 찾을 수 없습니다.");
        loading.remove();
        preview.createEl("video", {
          attr: {
            src: this.plugin.app.vault.getResourcePath(file),
            controls: "",
            preload: "metadata",
            playsinline: "",
            title: entry.content || "ServiceNow 첨부 영상"
          }
        });
      }).catch((error) => {
        if (!preview.isConnected) return;
        loading.setText(`영상 미리보기 실패: ${error.message || error}`);
      });
    }
    const link = card.createEl("a", {
      text: image || video ? `${entry.content || "첨부파일"} · ServiceNow에서 열기` : entry.content || "첨부파일 열기",
      href: entry.url,
      cls: "clt-sn-attachment-link"
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");
  }
}

class TicketStatusRenderChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, ticketId) {
    super(containerEl);
    this.plugin = plugin;
    this.ticketId = ticketId;
  }
  onload() {
    this.plugin.registerView(this.ticketId, this);
    this.render();
    this.plugin.scheduleViewRefresh(this.ticketId, "root");
  }
  onunload() {
    this.plugin.unregisterView(this.ticketId, this);
  }
  render() {
    this.containerEl.empty();
    this.plugin.renderTicketStatusControl(this.containerEl, this.ticketId);
  }
}

class MeetingSectionRenderChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, ticketId) {
    super(containerEl);
    this.plugin = plugin;
    this.ticketId = ticketId;
    this.refreshTimer = null;
  }
  onload() {
    const refreshIfRelevant = (file, oldPath = "") => {
      const folder = `${this.plugin.ticketMeetingsFolder(this.ticketId)}/`;
      if (!String(file?.path || "").startsWith(folder) && !String(oldPath || "").startsWith(folder)) return;
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => this.render(), 120);
    };
    this.registerEvent(this.plugin.app.vault.on("create", refreshIfRelevant));
    this.registerEvent(this.plugin.app.vault.on("delete", refreshIfRelevant));
    this.registerEvent(this.plugin.app.vault.on("rename", refreshIfRelevant));
    this.registerEvent(this.plugin.app.vault.on("modify", refreshIfRelevant));
    this.registerEvent(this.plugin.app.metadataCache.on("changed", refreshIfRelevant));
    this.render();
  }
  onunload() {
    window.clearTimeout(this.refreshTimer);
  }
  render() {
    this.containerEl.empty();
    this.plugin.renderTicketMeetingSection(this.containerEl, this.ticketId);
  }
}

class DocumentCandidateModal extends Modal {
  constructor(app, ticketId, candidateGroups, currentValues, onSubmit) {
    super(app);
    this.ticketId = ticketId;
    this.candidateGroups = candidateGroups;
    this.currentValues = currentValues;
    this.onSubmit = onSubmit;
    this.selected = {};
    this.finished = false;
  }

  onOpen() {
    this.contentEl.empty();
    this.titleEl.setText(`${this.ticketId} 문서 링크 선택`);
    this.contentEl.createEl("p", {
      text: "후보가 여러 개인 문서만 표시됩니다. 반영할 링크를 고르고 확인을 누르세요. 선택하지 않은 필드는 기존 값을 유지합니다."
    });
    Object.entries(this.candidateGroups).forEach(([type, candidates]) => {
      const section = this.contentEl.createDiv({ cls: "clt-sn-document-section" });
      section.createEl("h4", { text: `${type} 후보 ${candidates.length}개` });
      const groupName = `clt-doc-${this.ticketId}-${type}-${Date.now()}`;
      const keep = section.createEl("label", { cls: "clt-sn-document-candidate" });
      const keepRadio = keep.createEl("input", { type: "radio" });
      keepRadio.name = groupName;
      keepRadio.checked = true;
      keepRadio.addEventListener("change", () => { if (keepRadio.checked) delete this.selected[type]; });
      keep.createSpan({ text: this.currentValues[type] ? "기존 링크 유지" : "선택하지 않음" });
      candidates.forEach((candidate) => {
        const row = section.createEl("label", { cls: "clt-sn-document-candidate" });
        const radio = row.createEl("input", { type: "radio" });
        radio.name = groupName;
        radio.addEventListener("change", () => { if (radio.checked) this.selected[type] = candidate.url; });
        const body = row.createDiv({ cls: "clt-sn-document-candidate-body" });
        const link = body.createEl("a", { text: candidate.name, href: candidate.url });
        link.setAttr("target", "_blank");
        link.addEventListener("click", (event) => event.stopPropagation());
        body.createDiv({ cls: "clt-sn-document-candidate-url", text: candidate.url });
        const detail = [candidate.modifiedTime, candidate.source].filter(Boolean).join(" · ");
        if (detail) body.createDiv({ cls: "clt-sn-document-candidate-meta", text: detail });
      });
    });
    const actions = this.contentEl.createDiv({ cls: "clt-sn-document-actions" });
    const cancel = actions.createEl("button", { text: "취소" });
    cancel.addEventListener("click", () => { this.finish({}); this.close(); });
    const confirm = actions.createEl("button", { text: "선택 반영", cls: "mod-cta" });
    confirm.addEventListener("click", () => {
      this.finish(this.selected);
      this.close();
    });
  }

  finish(value) {
    if (this.finished) return;
    this.finished = true;
    this.onSubmit(value);
  }

  onClose() {
    this.finish({});
    this.contentEl.empty();
  }
}

class BearerTokenModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("ServiceNow Bearer Token 연결");
    contentEl.createEl("p", {
      text: "본인에게 정식으로 발급된 Bearer Token만 붙여넣으세요. 브라우저 세션 쿠키나 다른 사람의 토큰은 사용하지 마세요."
    });
    const input = contentEl.createEl("input", { type: "password" });
    input.addClass("clt-sn-token-input");
    input.setAttr("placeholder", "Bearer 접두어 없이 토큰만 붙여넣기");
    input.setAttr("autocomplete", "off");
    const status = contentEl.createDiv({ cls: "clt-sn-token-status" });

    const actions = new Setting(contentEl);
    actions.addButton((button) => button
      .setButtonText("취소")
      .onClick(() => this.close()));
    actions.addButton((button) => button
      .setButtonText("저장하고 연결 확인")
      .setCta()
      .onClick(async () => {
        const token = cleanBearerToken(input.value);
        if (token.length < 20) {
          status.setText("올바른 Bearer Token을 입력하세요.");
          return;
        }
        button.setDisabled(true);
        button.setButtonText("확인 중…");
        status.setText("토큰을 SecretStorage에 저장하고 CR/SR 조회 권한을 확인합니다.");
        try {
          await this.plugin.saveManualBearerToken(token);
          await this.plugin.testConnection();
          this.close();
        } catch (error) {
          status.setText(`연결 실패: ${error.message}`);
          button.setDisabled(false);
          button.setButtonText("저장하고 연결 확인");
        }
      }));
    window.setTimeout(() => input.focus(), 50);
  }

  onClose() {
    this.tokenValue = "";
    this.googleJsonValue = "";
    this.organizationPackValue = "";
    this.contentEl.empty();
  }
}

class FirstRunSetupModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.step = 0;
    this.finished = false;
    this.rootFolderValue = plugin.settings.rootFolder || "ServiceNow";
    this.instanceUrlValue = plugin.settings.instanceUrl || "";
    this.authModeValue = plugin.settings.authMode || "bearer";
    this.clientIdValue = plugin.settings.clientId || "";
    this.oauthScopeValue = plugin.settings.oauthScope || "";
    this.tokenValue = "";
    this.googleJsonValue = "";
    this.organizationPackValue = "";
    this.readingViewDefaultValue = plugin.isReadingViewDefault();
    this.statusMessage = "";
  }

  onOpen() {
    this.modalEl.addClass("snm-setup-modal");
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    const steps = ["시작", "화면 설정", "필수 플러그인", "ServiceNow", "Google Drive", "업무가이드팩", "완료"];
    this.titleEl.setText(`ServiceNow Manage 초기 설정 · ${steps[this.step]}`);
    contentEl.createDiv({ cls: "snm-setup-progress", text: `${this.step + 1} / ${steps.length}` });

    if (this.step === 0) this.renderWelcome(contentEl);
    if (this.step === 1) this.renderDisplaySettings(contentEl);
    if (this.step === 2) this.renderDependencies(contentEl);
    if (this.step === 3) this.renderServiceNow(contentEl);
    if (this.step === 4) this.renderGoogle(contentEl);
    if (this.step === 5) this.renderOrganizationPack(contentEl);
    if (this.step === 6) this.renderSummary(contentEl);

    if (this.statusMessage) contentEl.createDiv({ cls: "snm-setup-status", text: this.statusMessage });
    const footer = contentEl.createDiv({ cls: "snm-setup-footer" });
    const later = footer.createEl("button", { text: "나중에 설정" });
    later.addEventListener("click", () => this.complete(false));
    const navigation = footer.createDiv({ cls: "snm-setup-navigation" });
    if (this.step > 0) {
      const back = navigation.createEl("button", { text: "이전" });
      back.addEventListener("click", () => {
        this.statusMessage = "";
        this.step -= 1;
        this.render();
      });
    }
    const next = navigation.createEl("button", {
      cls: "mod-cta",
      text: this.step === steps.length - 1 ? "설정 완료" : "다음"
    });
    next.addEventListener("click", async () => {
      next.disabled = true;
      try {
        await this.saveCurrentStep();
        if (this.step === steps.length - 1) return await this.complete(true);
        this.statusMessage = "";
        this.step += 1;
        this.render();
      } catch (error) {
        this.statusMessage = error.message || String(error);
        next.disabled = false;
        this.render();
      }
    });
  }

  renderWelcome(contentEl) {
    contentEl.createEl("p", {
      text: "처음 사용하는 데 필요한 항목을 순서대로 확인합니다. 모든 항목은 나중에 설정 → ServiceNow Manage에서 다시 변경할 수 있습니다."
    });
    new Setting(contentEl)
      .setName("루트 폴더")
      .setDesc("티켓, 업무현황, 템플릿을 저장할 Vault 폴더입니다. 기존 사용자는 현재 값이 그대로 표시됩니다.")
      .addText((text) => text
        .setPlaceholder("ServiceNow")
        .setValue(this.rootFolderValue)
        .onChange((value) => { this.rootFolderValue = value; }));
    contentEl.createDiv({
      cls: "snm-setup-note",
      text: "기존 Vault에서 루트 폴더를 실제로 옮길 때는 초기 설정 후 일반 설정의 ‘적용’ 버튼을 사용하세요."
    });
  }

  renderDependencies(contentEl) {
    contentEl.createEl("p", { text: "업무현황에는 Dataview의 JavaScript Query 기능이 필요합니다. Translate는 워킹노트 번역을 사용할 때만 필요합니다." });
    const dataview = this.plugin.app.plugins?.plugins?.dataview;
    const dataviewJsEnabled = dataview ? dataview.settings?.enableDataviewJs === true : false;
    const dataviewCard = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
    dataviewCard.createEl("strong", {
      text: `Dataview · ${!dataview ? "설치 필요" : (dataviewJsEnabled ? "🟢 JavaScript Queries 켜짐" : "🔴 JavaScript Queries 꺼짐 (활성화 필요)")}`
    });
    dataviewCard.createEl("p", {
      text: !dataview
        ? "Dataview가 설치되지 않았습니다. 업무 목록과 To-Do 보드를 표시하려면 먼저 설치해 주세요."
        : (dataviewJsEnabled
          ? "Dataview와 JavaScript Queries가 정상 작동 중입니다. 업무현황 대시보드를 사용할 수 있습니다."
          : "Dataview가 설치되어 있지만 ‘Enable JavaScript Queries’가 꺼져 있습니다. 아래 버튼으로 켤 수 있습니다.")
    });
    const dataviewActions = dataviewCard.createDiv({ cls: "snm-setup-inline-actions" });
    if (dataview && !dataviewJsEnabled) {
      const enableJsButton = dataviewActions.createEl("button", { cls: "mod-cta", text: "JavaScript Queries 즉시 켜기" });
      enableJsButton.addEventListener("click", async () => {
        try {
          dataview.settings.enableDataviewJs = true;
          if (typeof dataview.saveSettings === "function") await dataview.saveSettings();
          this.statusMessage = "Dataview JavaScript Queries를 활성화했습니다.";
        } catch (error) {
          this.statusMessage = `Dataview 설정 갱신 실패: ${error.message || error}`;
        }
        this.render();
      });
    }
    const dataviewButton = dataviewActions.createEl("button", { text: dataview ? "Dataview 설정 열기" : "Dataview 설치 화면 열기" });
    dataviewButton.addEventListener("click", () => this.plugin.openDataviewSetup());

    const translate = this.plugin.app.plugins?.plugins?.translate;
    const translateCard = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
    translateCard.createEl("strong", { text: `Translate · ${translate ? "설치됨" : "선택 설치"}` });
    translateCard.createEl("p", { text: "Short Description, Description, 워킹노트를 번역합니다. DeepL API Free 계정의 인증 키 등을 Translate 플러그인 설정에 등록해야 합니다." });
    const translateButton = translateCard.createEl("button", { text: translate ? "Translate 설정 열기" : "Translate 설치 화면 열기" });
    translateButton.addEventListener("click", () => this.plugin.openTranslateSetup());
    contentEl.createDiv({ cls: "snm-setup-note", text: "Obsidian의 제한 모드가 켜져 있으면 먼저 설정 → 커뮤니티 플러그인에서 제한 모드를 해제해 주세요. 보안상 플러그인이 이 설정을 임의로 변경하지는 않습니다." });
  }

  renderDisplaySettings(contentEl) {
    contentEl.createEl("p", {
      text: "티켓 노트의 To-Do 보드와 작업 버튼은 읽기 화면에서 표시됩니다. 새 탭에서 노트를 열 때 읽기 화면을 기본값으로 사용하도록 설정할 수 있습니다."
    });
    new Setting(contentEl)
      .setName("새 탭을 읽기 화면으로 열기")
      .setDesc("Obsidian 전체의 새 Markdown 탭에 적용됩니다. 노트를 편집해야 할 때는 해당 탭에서 언제든 편집 화면으로 전환할 수 있습니다.")
      .addToggle((toggle) => toggle
        .setValue(this.readingViewDefaultValue)
        .onChange((value) => { this.readingViewDefaultValue = value; }));
    new Setting(contentEl)
      .setName("모든 파일 형식 표시")
      .setDesc("assets 폴더의 Excel·Word·PowerPoint 파일을 파일 탐색기와 플러그인 문서 검색에서 찾을 수 있도록 활성화합니다.")
      .addToggle((toggle) => toggle
        .setValue(true)
        .setDisabled(true));
    const quickApply = contentEl.createEl("button", {
      cls: this.plugin.isReadingViewDefault() ? "" : "mod-cta",
      text: this.plugin.isReadingViewDefault() ? "현재 읽기 화면으로 설정됨" : "지금 읽기 화면을 기본값으로 적용"
    });
    quickApply.addEventListener("click", async () => {
      try {
        await this.plugin.setReadingViewDefault(true, { notify: false });
        await this.plugin.setShowAllFileTypes(true, { notify: false });
        this.readingViewDefaultValue = true;
        this.statusMessage = "읽기 화면과 모든 파일 형식 표시를 적용했습니다.";
      } catch (error) {
        this.statusMessage = `화면 설정 실패: ${error.message || error}`;
      }
      this.render();
    });
    contentEl.createDiv({
      cls: "snm-setup-note",
      text: "Excel 파일은 Obsidian 파일 탐색기에 표시되며 클릭하면 시스템 기본 앱에서 열립니다. 이미 열려 있는 탭의 화면은 바뀌지 않습니다. 설정 후 새 탭을 열거나 기존 탭을 다시 열어 확인해 주세요."
    });
  }

  renderServiceNow(contentEl) {
    contentEl.createEl("p", {
      text: "주소는 https://회사인스턴스.service-now.com 형식으로 입력하세요. 뒤의 /now, /nav_to.do 등 화면 경로는 입력하지 않습니다. 조직에서 허용한 인증 방식만 사용하세요."
    });
    new Setting(contentEl)
      .setName("ServiceNow 주소")
      .addText((text) => text
        .setPlaceholder("https://your-instance.service-now.com")
        .setValue(this.instanceUrlValue)
        .onChange((value) => { this.instanceUrlValue = value; }));
    new Setting(contentEl)
      .setName("인증 방식")
      .setDesc("OAuth는 ServiceNow 관리자가 미리 등록한 Public Client ID가 있을 때 사용할 수 있습니다.")
      .addDropdown((dropdown) => dropdown
        .addOption("bearer", "조직에서 제공한 Bearer Token")
        .addOption("oauth", "브라우저 OAuth PKCE 로그인")
        .setValue(this.authModeValue)
        .onChange((value) => { this.authModeValue = value; this.render(); }));
    if (this.authModeValue === "bearer") {
      new Setting(contentEl)
        .setName("Bearer Token")
        .setDesc(this.plugin.getSecret(ACCESS_TOKEN_KEY) ? "이미 저장된 Token이 있습니다. 비워 두면 기존 Token을 유지합니다." : "Token은 Obsidian SecretStorage에 저장됩니다.")
        .addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "off";
          text.setPlaceholder("Bearer 접두어 없이 입력")
            .setValue(this.tokenValue)
            .onChange((value) => { this.tokenValue = value; });
        });
    } else {
      new Setting(contentEl)
        .setName("OAuth Public Client ID")
        .setDesc("ServiceNow 관리자가 OAuth Application Registry에서 발급한 값입니다. Client Secret은 필요하지 않습니다.")
        .addText((text) => text.setPlaceholder("관리자 발급 Client ID").setValue(this.clientIdValue).onChange((value) => { this.clientIdValue = value.trim(); }));
      new Setting(contentEl)
        .setName("OAuth scope · 선택")
        .addText((text) => text.setPlaceholder("관리자가 지정한 경우만 입력").setValue(this.oauthScopeValue).onChange((value) => { this.oauthScopeValue = value.trim(); }));
    }
    const test = contentEl.createEl("button", { text: "저장 후 연결 확인" });
    test.addEventListener("click", async () => {
      test.disabled = true;
      try {
        await this.saveServiceNow();
        if (this.authModeValue === "oauth") {
          await this.plugin.connectServiceNow();
          this.statusMessage = "브라우저에서 ServiceNow 로그인을 완료해 주세요. 로그인 완료 후 설정의 연결 확인을 사용할 수 있습니다.";
        } else {
          await this.plugin.testConnection();
          this.statusMessage = "ServiceNow 연결을 확인했습니다.";
        }
      } catch (error) {
        this.statusMessage = `연결 확인 실패: ${error.message || error}`;
      }
      this.render();
    });
  }

  renderGoogle(contentEl) {
    const ready = Boolean(this.plugin.settings.googleClientId && this.plugin.getSecret(GOOGLE_CLIENT_SECRET_KEY));
    const googleConnected = Boolean(this.plugin.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.plugin.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    const permissionInfo = this.plugin.getGooglePermissionInfo();

    contentEl.createEl("p", {
      text: "Google Drive 문서 검색을 사용할 때만 등록하세요. Desktop OAuth JSON 파일을 선택하거나 JSON 원문을 붙여넣을 수 있습니다."
    });
    if (ready) {
      const card = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
      const heading = card.createEl("strong", { text: `Google OAuth JSON 등록됨 · ${this.plugin.settings.googleClientId}` });
      if (googleConnected && permissionInfo.badge) {
        heading.createSpan({
          cls: permissionInfo.hasDownloadPermission ? "snm-scope-badge is-valid" : "snm-scope-badge is-warning",
          text: permissionInfo.badge
        });
      }
      const desc = googleConnected
        ? `계정: ${this.plugin.settings.googleAccountEmail || "연결됨"}${permissionInfo.permissionLabel ? ` · ${permissionInfo.permissionLabel}` : ""}`
        : "OAuth JSON이 성공적으로 등록되었습니다. 티켓 생성 시 Google Drive 문서 자동 검색을 사용할 수 있습니다.";
      card.createEl("p", { text: desc });
      const actions = card.createDiv({ cls: "snm-setup-inline-actions" });
      if (googleConnected && permissionInfo.needsReauth) {
        const reauthButton = actions.createEl("button", {
          cls: "mod-cta mod-warning",
          text: "재인증 필요 (다운로드 권한 추가)"
        });
        reauthButton.addEventListener("click", () => this.plugin.connectGoogleDrive());
      }
      const fileButton = actions.createEl("button", { text: "OAuth JSON 교체" });
      fileButton.addEventListener("click", () => this.plugin.importGoogleOAuthJson(() => {
        this.statusMessage = "Google OAuth JSON을 등록했습니다.";
        this.render();
      }));
      const removeButton = actions.createEl("button", { text: "JSON 제거" });
      removeButton.addEventListener("click", async () => {
        this.plugin.settings.googleClientId = "";
        this.plugin.setSecret(GOOGLE_CLIENT_SECRET_KEY, "");
        await this.plugin.savePluginData();
        this.statusMessage = "Google OAuth JSON을 제거했습니다.";
        this.render();
      });
      contentEl.createDiv({ cls: "snm-setup-note", text: "Google 계정 연결은 초기 설정 완료 후 일반 설정에서도 언제든 진행할 수 있습니다." });
      return;
    }

    const actions = contentEl.createDiv({ cls: "snm-setup-inline-actions" });
    const fileButton = actions.createEl("button", { text: "OAuth JSON 파일 선택" });
    fileButton.addEventListener("click", () => this.plugin.importGoogleOAuthJson(() => {
      this.statusMessage = "Google OAuth JSON을 등록했습니다.";
      this.render();
    }));
    const textarea = contentEl.createEl("textarea", { cls: "snm-setup-json-input" });
    textarea.setAttr("placeholder", "또는 Google Desktop OAuth JSON 원문 붙여넣기");
    textarea.value = this.googleJsonValue;
    textarea.addEventListener("input", () => { this.googleJsonValue = textarea.value; });
    contentEl.createDiv({ cls: "snm-setup-note", text: "JSON을 붙여넣은 경우 ‘다음’을 누를 때 자동으로 검증하고 저장합니다. 비워 두면 이 단계를 건너뜁니다." });
    const pasteButton = contentEl.createEl("button", { text: "붙여넣은 JSON 등록" });
    pasteButton.addEventListener("click", async () => {
      pasteButton.disabled = true;
      try {
        await this.plugin.applyGoogleOAuthJson(JSON.parse(this.googleJsonValue));
        this.googleJsonValue = "";
        this.statusMessage = "Google OAuth JSON을 등록했습니다. 설정에서 Google 계정 연결을 계속할 수 있습니다.";
      } catch (error) {
        this.statusMessage = `Google OAuth JSON 등록 실패: ${error.message || error}`;
      }
      this.render();
    });
    contentEl.createDiv({ cls: "snm-setup-note", text: "Google 계정을 연결하지 않아도 ServiceNow, 로컬 노트, 업무현황과 To-Do 기능은 사용할 수 있습니다." });
  }

  renderOrganizationPack(contentEl) {
    const ready = this.plugin.hasOrganizationPack();
    contentEl.createEl("p", {
      text: "업무가이드팩이 있나요? 조직에서 별도로 제공한 업무가이드팩이 있으면 등록하세요. 상태별 업무 가이드와 조직 AI 템플릿은 팩이 있을 때만 표시됩니다."
    });
    if (ready) {
      const card = contentEl.createDiv({ cls: "snm-setup-dependency-card" });
      const version = this.plugin.organizationPack.version ? ` · v${this.plugin.organizationPack.version}` : "";
      card.createEl("strong", { text: `업무가이드팩 등록됨 · ${this.plugin.organizationPack.name}${version}` });
      card.createEl("p", { text: `팩 ID: ${this.plugin.organizationPack.packId || "custom"} · 상태별 가이드 및 AI 프롬프트가 활성화됩니다.` });
      const actions = card.createDiv({ cls: "snm-setup-inline-actions" });
      const fileButton = actions.createEl("button", { text: "업무가이드팩 교체" });
      fileButton.addEventListener("click", () => this.plugin.importOrganizationPack(() => {
        this.statusMessage = "업무가이드팩을 등록했습니다.";
        this.render();
      }));
      const removeButton = actions.createEl("button", { text: "팩 제거" });
      removeButton.addEventListener("click", async () => {
        await this.plugin.removeOrganizationPack(() => {
          this.statusMessage = "업무가이드팩을 제거했습니다.";
          this.render();
        });
      });
      contentEl.createDiv({ cls: "snm-setup-note", text: "업무가이드팩이 없어도 ServiceNow 조회, 워킹노트, 업무현황과 To-Do는 정상적으로 사용할 수 있습니다." });
      return;
    }

    const actions = contentEl.createDiv({ cls: "snm-setup-inline-actions" });
    const fileButton = actions.createEl("button", { text: "업무가이드팩 파일 선택" });
    fileButton.addEventListener("click", () => this.plugin.importOrganizationPack(() => {
      this.statusMessage = "업무가이드팩을 등록했습니다.";
      this.render();
    }));
    const textarea = contentEl.createEl("textarea", { cls: "snm-setup-json-input" });
    textarea.setAttr("placeholder", "또는 업무가이드팩 JSON 원문 붙여넣기");
    textarea.value = this.organizationPackValue;
    textarea.addEventListener("input", () => { this.organizationPackValue = textarea.value; });
    contentEl.createDiv({ cls: "snm-setup-note", text: "업무가이드팩을 붙여넣은 경우 ‘다음’을 누를 때 자동으로 검증하고 저장합니다. 비워 두면 건너뜁니다." });
    const pasteButton = contentEl.createEl("button", { text: "붙여넣은 업무가이드팩 등록" });
    pasteButton.addEventListener("click", async () => {
      pasteButton.disabled = true;
      try {
        const pack = await this.plugin.applyOrganizationPack(JSON.parse(this.organizationPackValue));
        const templateResult = this.plugin.lastOrganizationPackApplyResult || {};
        this.organizationPackValue = "";
        this.statusMessage = `업무가이드팩을 등록했습니다: ${pack.name}${templateResult.updated ? ` · 기본 템플릿 갱신 ${templateResult.updated}개` : ""}${templateResult.preserved ? ` · 사용자 수정 템플릿 보존 ${templateResult.preserved}개` : ""}`;
      } catch (error) {
        this.statusMessage = `업무가이드팩 등록 실패: ${error.message || error}`;
      }
      this.render();
    });
    contentEl.createDiv({ cls: "snm-setup-note", text: "업무가이드팩이 없어도 ServiceNow 조회, 워킹노트, 업무현황과 To-Do는 정상적으로 사용할 수 있습니다." });
  }

  renderSummary(contentEl) {
    const rows = [
      ["루트 폴더", this.plugin.rootFolder()],
      ["새 탭 기본 화면", this.plugin.isReadingViewDefault() ? "읽기 화면" : "편집 화면"],
      ["ServiceNow 주소", this.plugin.settings.instanceUrl || "나중에 설정"],
      ["ServiceNow 인증", this.plugin.settings.authMode === "oauth" ? "OAuth PKCE" : "Bearer Token"],
      ["ServiceNow Token", this.plugin.getSecret(ACCESS_TOKEN_KEY) ? "등록됨" : "나중에 설정"],
      ["Google OAuth JSON", this.plugin.settings.googleClientId && this.plugin.getSecret(GOOGLE_CLIENT_SECRET_KEY) ? "등록됨" : "사용 안 함 / 나중에 설정"],
      ["업무가이드팩", this.plugin.hasOrganizationPack() ? `${this.plugin.organizationPack.name}${this.plugin.organizationPack.version ? ` v${this.plugin.organizationPack.version}` : ""}` : "사용 안 함 / 나중에 설정"]
    ];
    const summary = contentEl.createDiv({ cls: "snm-setup-summary" });
    for (const [label, value] of rows) {
      const row = summary.createDiv({ cls: "snm-setup-summary-row" });
      row.createEl("strong", { text: label });
      row.createEl("span", { text: value });
    }
    contentEl.createEl("p", { text: "설정 완료 후에도 설정 → ServiceNow Manage → 초기 설정 도우미에서 다시 실행할 수 있습니다." });
  }

  async saveRootFolder() {
    const next = normalizePath(String(this.rootFolderValue || "").trim()).replace(/^\/+|\/+$/g, "") || "ServiceNow";
    this.plugin.settings.rootFolder = next;
    await this.plugin.savePluginData();
  }

  async saveCurrentStep() {
    if (this.step === 0) return this.saveRootFolder();
    if (this.step === 1) {
      await this.plugin.setReadingViewDefault(this.readingViewDefaultValue, { notify: false });
      return this.plugin.setShowAllFileTypes(true, { notify: false });
    }
    if (this.step === 3) return this.saveServiceNow();
    if (this.step === 4 && this.googleJsonValue.trim()) {
      await this.plugin.applyGoogleOAuthJson(JSON.parse(this.googleJsonValue));
      this.googleJsonValue = "";
      return;
    }
    if (this.step === 5 && this.organizationPackValue.trim()) {
      await this.plugin.applyOrganizationPack(JSON.parse(this.organizationPackValue));
      this.organizationPackValue = "";
    }
  }

  async saveServiceNow() {
    this.plugin.settings.instanceUrl = cleanInstanceUrl(this.instanceUrlValue);
    this.plugin.settings.authMode = this.authModeValue;
    this.plugin.settings.clientId = this.clientIdValue;
    this.plugin.settings.oauthScope = this.oauthScopeValue;
    const token = cleanBearerToken(this.tokenValue);
    if (this.authModeValue === "bearer" && this.tokenValue && token.length < 20) throw new Error("올바른 Bearer Token을 입력하세요.");
    if (token) {
      await this.plugin.saveManualBearerToken(token);
      this.tokenValue = "";
    } else {
      await this.plugin.savePluginData();
    }
  }

  async complete(finished) {
    this.finished = true;
    this.plugin.settings.setupWizardVersion = FIRST_RUN_SETUP_VERSION;
    await this.plugin.savePluginData();
    if (finished) {
      await this.plugin.ensureWorkspaceScaffold();
      new Notice("ServiceNow Manage 초기 설정을 완료했습니다.", 6000);
    } else {
      new Notice("초기 설정을 닫았습니다. 설정에서 언제든 다시 열 수 있습니다.", 6000);
    }
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class WorkNotesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.plugin.workNotesSettingTab = this;
  }

  display() {
    const { containerEl } = this;
    const scrollContainer = containerEl.closest(".vertical-tab-content") || containerEl.parentElement || containerEl;
    const savedScrollTop = scrollContainer?.scrollTop || containerEl.scrollTop || 0;
    containerEl.empty();

    new Setting(containerEl)
      .setName("초기 설정 도우미")
      .setDesc("ServiceNow 주소·Token, 선택 Google OAuth JSON과 업무가이드팩을 단계별로 다시 확인합니다.")
      .addButton((button) => button
        .setButtonText("다시 열기")
        .setCta()
        .onClick(() => this.plugin.openSetupWizard()));

    new Setting(containerEl)
      .setName("새 탭 기본 화면")
      .setDesc("읽기 화면을 선택하면 티켓 노트의 To-Do 보드와 작업 버튼이 새 탭에서 바로 표시됩니다. 기존에 열린 탭에는 영향을 주지 않습니다.")
      .addDropdown((dropdown) => dropdown
        .addOption("preview", "읽기 화면")
        .addOption("source", "편집 화면")
        .setValue(this.plugin.isReadingViewDefault() ? "preview" : "source")
        .onChange(async (value) => {
          await this.plugin.setReadingViewDefault(value === "preview");
        }));

    let pendingRootFolder = this.plugin.settings.rootFolder;
    new Setting(containerEl)
      .setName("루트 폴더")
      .setDesc("티켓·업무현황·업무가이드 템플릿이 위치할 기준 폴더입니다. 대상 폴더가 이미 있으면 기존 내용을 유지한 채 해당 폴더를 사용합니다.")
      .addText((text) => text
        .setPlaceholder("ServiceNow")
        .setValue(this.plugin.settings.rootFolder)
        .onChange((value) => { pendingRootFolder = value; }))
      .addButton((button) => button
        .setButtonText("적용")
        .setCta()
        .onClick(() => this.plugin.requestRootFolderChange(pendingRootFolder, () => this.display())));

    containerEl.createEl("h3", { text: "업무가이드팩" });
    containerEl.createEl("p", {
      text: "상태별 업무 가이드, 조직 전용 SLA와 AI 분석 템플릿은 공개 플러그인에 포함되지 않습니다. 조직에서 제공한 ServiceNow Manage 업무가이드팩(JSON)을 별도로 가져오세요."
    });
    const organizationPackReady = this.plugin.hasOrganizationPack();
    const organizationPackSetting = new Setting(containerEl)
      .setName("업무가이드팩")
      .setDesc(organizationPackReady
        ? `등록됨 · ${this.plugin.organizationPack.name} (${this.plugin.organizationPack.packId})${this.plugin.organizationPack.version ? ` · v${this.plugin.organizationPack.version}` : ""}`
        : "등록되지 않음 · 기본 ServiceNow 및 To-Do 기능은 계속 사용할 수 있습니다.");
    organizationPackSetting.addButton((button) => button
      .setButtonText(organizationPackReady ? "팩 교체" : "JSON 가져오기")
      .setCta()
      .onClick(() => this.plugin.importOrganizationPack(() => this.display())));
    organizationPackSetting.addButton((button) => button
      .setButtonText("팩 제거")
      .setDisabled(!organizationPackReady)
      .onClick(() => this.plugin.removeOrganizationPack(() => this.display())));

    new Setting(containerEl)
      .setName("업무가이드 기능 표시")
      .setDesc("등록된 팩의 상태 가이드, SLA 규칙과 AI 프롬프트 기능을 표시합니다. 팩이 없으면 활성화할 수 없습니다.")
      .addToggle((toggle) => toggle
        .setDisabled(!organizationPackReady)
        .setValue(organizationPackReady && this.plugin.settings.organizationFeaturesEnabled)
        .onChange(async (value) => {
          this.plugin.settings.organizationFeaturesEnabled = organizationPackReady && value;
          if (this.plugin.settings.organizationFeaturesEnabled) await this.plugin.ensureOrganizationTemplates();
          await this.plugin.savePluginData();
          this.display();
        }));

    new Setting(containerEl)
      .setName("ServiceNow 주소")
      .setDesc("https://회사인스턴스.service-now.com 형식만 입력합니다. /now 또는 화면 경로는 제외합니다.")
      .addText((text) => text
        .setPlaceholder("https://your-instance.service-now.com")
        .setValue(this.plugin.settings.instanceUrl)
        .onChange(async (value) => {
          this.plugin.settings.instanceUrl = cleanInstanceUrl(value);
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("인증 방식")
      .setDesc("관리자 등록이 없으면 기존 Bearer Token 직접 입력을 사용하세요.")
      .addDropdown((dropdown) => dropdown
        .addOption("bearer", "기존 Bearer Token 직접 입력")
        .addOption("oauth", "OAuth PKCE 로그인")
        .setValue(this.plugin.settings.authMode)
        .onChange(async (value) => {
          this.plugin.settings.authMode = value;
          await this.plugin.savePluginData();
          this.display();
        }));

    if (this.plugin.settings.authMode === "oauth") {
      new Setting(containerEl)
        .setName("OAuth client ID")
        .setDesc("ServiceNow 관리자가 발급한 Public Client ID. Client Secret은 입력하지 않습니다.")
        .addText((text) => text
          .setPlaceholder("관리자 발급 후 입력")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.savePluginData();
          }));

      new Setting(containerEl)
        .setName("OAuth scope")
        .setDesc("관리자가 지정한 읽기 전용 scope. 지정받지 않았다면 비워둘 수 있습니다.")
        .addText((text) => text
          .setPlaceholder("예: clt_worknotes_read")
          .setValue(this.plugin.settings.oauthScope)
          .onChange(async (value) => {
            this.plugin.settings.oauthScope = value.trim();
            await this.plugin.savePluginData();
          }));

      new Setting(containerEl)
        .setName("OAuth callback URL")
        .setDesc("ServiceNow Application Registry에 동일하게 등록해야 합니다. 기본값은 이 PC의 로컬 주소입니다.")
        .addText((text) => text
          .setPlaceholder("http://127.0.0.1:42813/oauth/callback")
          .setValue(this.plugin.settings.redirectUri)
          .onChange(async (value) => {
            this.plugin.settings.redirectUri = value.trim();
            await this.plugin.savePluginData();
          }));
    }



    containerEl.createEl("h3", { text: "고급 ServiceNow API 설정" });
    containerEl.createEl("p", { text: "회사별 ServiceNow 테이블 이름이 다를 때만 변경하세요." });
    for (const [key, label, placeholder] of [
      ["changeRequestTable", "CR 테이블", "change_request"],
      ["serviceRequestTable", "SR 테이블", "u_service_call"],
      ["incidentTable", "Incident 테이블", "incident"]
    ]) {
      new Setting(containerEl)
        .setName(label)
        .addText((input) => input
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings[key] || placeholder)
          .onChange(async (value) => {
            this.plugin.settings[key] = String(value || "").trim() || placeholder;
            await this.plugin.savePluginData();
          }));
    }

    new Setting(containerEl)
      .setName("새 티켓 워킹노트 자동 생성")
      .setDesc(`${this.plugin.settings.rootFolder}/티켓/<Ticket ID>/<Ticket ID>.md 형식의 새 CR/SR 원본 노트에 워킹노트를 만들고 링크 속성을 자동 추가합니다.`)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoCreateWorkNotes)
        .onChange(async (value) => {
          this.plugin.settings.autoCreateWorkNotes = value;
          await this.plugin.savePluginData();
        }));

    let pendingWorkNotesFolder = this.plugin.settings.workNotesFolder;
    new Setting(containerEl)
      .setName("워킹노트 생성 폴더")
      .setDesc("적용을 누르면 기존 워킹노트도 새 폴더로 이동합니다. 비우고 적용하면 각 티켓 노트 폴더로 되돌립니다.")
      .addText((text) => text
        .setPlaceholder("예: ServiceNow/워킹노트")
        .setValue(this.plugin.settings.workNotesFolder)
        .onChange((value) => { pendingWorkNotesFolder = value; }))
      .addButton((button) => button
        .setButtonText("적용")
        .setCta()
        .onClick(() => this.plugin.requestWorkNotesFolderChange(pendingWorkNotesFolder, () => this.display())));

    new Setting(containerEl)
      .setName("문서 자동화 사용")
      .setDesc("Description의 BS 링크와 Google Drive의 FS·DS·UT 문서 검색 기능을 표시합니다. 회사별 문서 규칙이 다르면 끌 수 있습니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.enableDocumentAutomation)
        .onChange(async (value) => {
          this.plugin.settings.enableDocumentAutomation = value;
          await this.plugin.savePluginData();
          this.display();
        }));

    new Setting(containerEl)
      .setName("새 티켓 문서 링크 자동 검색")
      .setDesc("새 CR/SR 티켓을 처음 만들 때만 BS·FS·DS·UT를 검색합니다. 끄더라도 티켓 노트의 문서 갱신 버튼으로 직접 검색할 수 있습니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoDocumentSearchOnNewTicket)
        .onChange(async (value) => {
          this.plugin.settings.autoDocumentSearchOnNewTicket = value;
          await this.plugin.savePluginData();
        }));

    containerEl.createEl("h3", { text: "Google Drive 문서 연결" });
    containerEl.createEl("p", {
      text: "선택 기능입니다. 파일명 규칙에 맞는 FS·DS·UT 검색과 AI 분석용 원본 다운로드에 사용합니다. BS처럼 별도 권한이 필요한 문서는 사용자가 직접 내려받을 수 있습니다."
    });
    const googleCredentialsReady = Boolean(
      this.plugin.settings.googleClientId && this.plugin.getSecret(GOOGLE_CLIENT_SECRET_KEY)
    );
    new Setting(containerEl)
      .setName("Google OAuth 설정")
      .setDesc(googleCredentialsReady
        ? `OAuth JSON 등록됨 · ${this.plugin.settings.googleClientId}`
        : "Google Cloud Console에서 받은 Desktop OAuth JSON 파일을 먼저 선택하세요.")
      .addButton((button) => button
        .setButtonText("OAuth JSON 선택")
        .onClick(() => this.plugin.importGoogleOAuthJson(() => this.display())));
    const googleConnected = Boolean(this.plugin.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.plugin.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    const permissionInfo = this.plugin.getGooglePermissionInfo();

    if (googleConnected && !this.plugin.settings.googleGrantedScopes) {
      void this.plugin.inspectGoogleTokenScopes().then((result) => {
        if (result.success && this.containerEl.isShown()) {
          this.display();
        }
      });
    }

    const descLines = [];
    if (googleConnected) {
      descLines.push(`${this.plugin.settings.googleAccountEmail || "연결됨"}${this.plugin.settings.googleConnectedAt ? ` · ${this.plugin.settings.googleConnectedAt}` : ""}`);
      if (permissionInfo.permissionLabel) {
        descLines.push(`보유 권한: ${permissionInfo.permissionLabel}`);
      }
    } else {
      descLines.push("연결되지 않음");
    }

    const googleConnection = new Setting(containerEl)
      .setName("Google 계정")
      .setDesc(descLines.join(" · "));

    if (googleConnected && permissionInfo.badge) {
      googleConnection.nameEl.createSpan({
        cls: permissionInfo.hasDownloadPermission ? "snm-scope-badge is-valid" : "snm-scope-badge is-warning",
        text: permissionInfo.badge
      });
    }

    const connectButtonText = !googleConnected
      ? "Google 계정 연결"
      : permissionInfo.needsReauth
        ? "재인증 필요 (권한 추가)"
        : "다시 연결";

    googleConnection.addButton((button) => {
      button
        .setButtonText(connectButtonText)
        .setCta()
        .setDisabled(!googleCredentialsReady)
        .onClick(() => this.plugin.connectGoogleDrive());
      if (googleConnected && permissionInfo.needsReauth) {
        button.buttonEl.addClass("mod-warning");
      }
    });
    googleConnection.addButton((button) => button
      .setButtonText("연결 해제")
      .setDisabled(!googleConnected)
      .onClick(async () => {
        await this.plugin.disconnectGoogleDrive();
        this.display();
      }));

    const statusSyncSetting = new Setting(containerEl)
      .setName("티켓 상태 하루 1회 자동 갱신")
      .setDesc(`Obsidian이 열려 있을 때 ${this.plugin.settings.rootFolder}/티켓의 상태·기본정보·워킹노트를 지정 시간 이후 하루 한 번 갱신합니다.`)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoStatusSync)
        .onChange(async (value) => {
          this.plugin.settings.autoStatusSync = value;
          await this.plugin.savePluginData();
          if (value) this.plugin.runDailyStatusSyncIfDue();
          this.display();
        }));
    if (this.plugin.settings.autoStatusSync) {
      statusSyncSetting.addText((text) => {
        text.inputEl.type = "time";
        text.setValue(this.plugin.settings.statusSyncTime || "09:00");
        text.onChange(async (value) => {
          if (!/^\d{2}:\d{2}$/.test(value)) return;
          this.plugin.settings.statusSyncTime = value;
          await this.plugin.savePluginData();
        });
      });
    }

    new Setting(containerEl)
      .setName("워킹노트 자동 갱신")
      .setDesc("Obsidian이 열려 있을 때 등록된 티켓의 상태·기본정보와 워킹노트를 자동 갱신합니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("워킹노트 매 정각 갱신")
      .setDesc("워킹노트 자동 갱신이 켜진 경우 상태·기본정보·워킹노트를 매 정각에 순차적으로 갱신합니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncAtTopOfHour)
        .onChange(async (value) => {
          this.plugin.settings.syncAtTopOfHour = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("실행 시 누락분 갱신")
      .setDesc("마지막 성공 이후 날짜가 바뀌었으면 Obsidian 실행 후 상태·기본정보·워킹노트를 한 번 갱신합니다.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.catchUpOnOpen)
        .onChange(async (value) => {
          this.plugin.settings.catchUpOnOpen = value;
          await this.plugin.savePluginData();
        }));

    const translateApi = this.plugin.getTranslateApi();
    const translationSetting = new Setting(containerEl)
      .setName("번역 연동")
      .setDesc(translateApi?.canTranslate
        ? "Translate 플러그인이 연결되어 있습니다. 워킹노트 화면에서 한국어/베트남어 번역을 실행할 수 있습니다."
        : "Community Plugins에서 Translate를 설치·설정하면 워킹노트 번역을 사용할 수 있습니다.");
    translationSetting.addButton((button) => button
      .setButtonText(translateApi ? "Translate 설정 열기" : "Translate 설치하기")
      .onClick(() => this.plugin.openTranslateSetup()));

    const dataview = this.plugin.app.plugins?.plugins?.dataview;
    const dataviewJsEnabled = dataview ? dataview.settings?.enableDataviewJs === true : false;
    const dataviewSetting = new Setting(containerEl)
      .setName("업무현황 필수 플러그인 · Dataview")
      .setDesc(dataview
        ? (dataviewJsEnabled
          ? "🟢 Dataview와 JavaScript Queries가 정상 활성화되어 있습니다."
          : "🔴 Dataview가 설치되어 있으나 ‘Enable JavaScript Queries’가 꺼져 있어 업무현황이 표시되지 않습니다.")
        : "Dataview가 설치되지 않았습니다. 업무 목록과 To-Do 보드를 표시하려면 설치가 필요합니다.");
    if (dataview && !dataviewJsEnabled) {
      dataviewSetting.addButton((button) => button
        .setButtonText("JavaScript Queries 즉시 켜기")
        .setCta()
        .onClick(async () => {
          try {
            dataview.settings.enableDataviewJs = true;
            if (typeof dataview.saveSettings === "function") await dataview.saveSettings();
            new Notice("Dataview JavaScript Queries를 활성화했습니다.", 5000);
          } catch (error) {
            new Notice(`Dataview 설정 실패: ${error.message || error}`, 7000);
          }
          this.display();
        }));
    }
    dataviewSetting.addButton((button) => button
      .setButtonText(dataview ? "Dataview 설정 열기" : "Dataview 설치하기")
      .onClick(() => this.plugin.openDataviewSetup()));

    new Setting(containerEl)
      .setName("업무현황 대시보드 템플릿")
      .setDesc("업무현황.md의 코드를 플러그인 최신 런타임(v2.6.8: 순서 변경 모드 및 노스크롤 팝업 지원)으로 갱신합니다.")
      .addButton((button) => button
        .setButtonText("대시보드 템플릿 갱신")
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("갱신 중…");
          try {
            const updated = await this.plugin.forceUpgradeDashboard();
            if (updated) {
              new Notice("업무현황 대시보드를 최신 버전(v2.6.8)으로 갱신했습니다.", 6000);
            } else {
              new Notice("업무현황 대시보드가 이미 최신 버전(v2.6.8)입니다.", 5000);
            }
          } catch (error) {
            new Notice(`업무현황 갱신 실패: ${error.message || error}`, 8000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("대시보드 템플릿 갱신");
          }
        }));

    const cachedYears = Object.keys(this.plugin.settings.holidayCache || {}).sort();
    const cachedCount = cachedYears.reduce(
      (count, year) => count + (this.plugin.settings.holidayCache?.[year]?.length || 0),
      0
    );
    const holidaySetting = new Setting(containerEl)
      .setName("공휴일")
      .setDesc(`Nager.Date 공개 자료로 대한민국 공휴일을 현재 연도와 다음 연도 기준으로 자동 관리합니다.${cachedYears.length ? ` 저장: ${cachedYears.join("·")}년 ${cachedCount}일` : " 아직 저장된 공휴일이 없습니다."}`)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoHolidaySync)
        .onChange(async (value) => {
          this.plugin.settings.autoHolidaySync = value;
          await this.plugin.savePluginData();
          if (value) await this.plugin.syncHolidayCalendar({ notify: true, force: true });
          this.display();
        }));
    holidaySetting.addButton((button) => button
      .setButtonText("지금 갱신")
      .setDisabled(!this.plugin.settings.autoHolidaySync)
      .onClick(async () => {
        button.setDisabled(true);
        button.setButtonText("갱신 중…");
        await this.plugin.syncHolidayCalendar({ notify: true, force: true });
        this.display();
      }));

    new Setting(containerEl)
      .setName("추가 공휴일")
      .setDesc("회사 휴무일 또는 자동 목록의 누락분을 YYYY-MM-DD 형식으로 추가합니다.")
      .addTextArea((text) => text
        .setPlaceholder("2026-08-17, 2026-09-24")
        .setValue(this.plugin.settings.koreanHolidays)
        .onChange(async (value) => {
          this.plugin.settings.koreanHolidays = value;
          await this.plugin.savePluginData();
        }));

    const connected = Boolean(this.plugin.getSecret(ACCESS_TOKEN_KEY));
    const connection = new Setting(containerEl)
      .setName("ServiceNow 연결")
      .setDesc(connected
        ? `토큰 저장됨${this.plugin.settings.connectedAt ? ` · 마지막 확인 ${this.plugin.settings.connectedAt}` : ""}`
        : "연결되지 않음");
    connection.addButton((button) => button
      .setButtonText(this.plugin.settings.authMode === "bearer" ? (connected ? "토큰 교체" : "토큰 입력") : (connected ? "다시 연결" : "연결"))
      .setCta()
      .onClick(() => this.plugin.connectServiceNow()));
    connection.addButton((button) => button
      .setButtonText("ServiceNow 열기")
      .setDisabled(!this.plugin.settings.instanceUrl)
      .onClick(() => shell.openExternal(cleanInstanceUrl(this.plugin.settings.instanceUrl))));
    connection.addButton((button) => button
      .setButtonText("연결 확인")
      .setDisabled(!connected)
      .onClick(() => this.plugin.testConnection().catch((error) => new Notice(`연결 실패: ${error.message}`, 9000))));
    connection.addButton((button) => button
      .setButtonText("연결 해제")
      .setDisabled(!connected)
      .onClick(async () => {
        await this.plugin.disconnectServiceNow();
        this.display();
      }));

    if (savedScrollTop > 0) {
      window.requestAnimationFrame(() => {
        if (scrollContainer) scrollContainer.scrollTop = savedScrollTop;
        if (containerEl) containerEl.scrollTop = savedScrollTop;
      });
    }
  }
}

class CltServiceNowWorkNotes extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    const savedSettings = saved.settings || {};
    const detectedRoot = Object.prototype.hasOwnProperty.call(savedSettings, "rootFolder")
      ? savedSettings.rootFolder
      : "ServiceNow";
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings, { rootFolder: detectedRoot || "ServiceNow" });
    this.data = {
      tickets: saved.tickets || {},
      todoMetadataVersion: Number(saved.todoMetadataVersion || 0)
    };
    this.organizationPack = await this.loadOrganizationPack();
    if (!this.organizationPack) this.settings.organizationFeaturesEnabled = false;
    else if (!Object.prototype.hasOwnProperty.call(savedSettings, "organizationFeaturesEnabled")) {
      this.settings.organizationFeaturesEnabled = true;
    }
    this.migrateLegacySecrets();
    this.views = new Map();
    this.syncing = new Set();
    this.statusSyncing = new Set();
    this.dailyStatusSyncing = false;
    this.translating = new Set();
    this.lastAutomationHour = "";
    this.pendingOAuth = null;
    this.oauthServer = null;
    this.pendingGoogleOAuth = null;
    this.googleOAuthServer = null;
    this.pendingNewTicketFiles = new Set();
    this.autoLinking = new Set();
    this.knownStatus = new Map();
    this.updatingStatus = new Set();
    this.attachmentImageCache = new Map();
    this.linkingLocalBs = new Set();
    this.ticketNoticeQueue = [];
    this.ticketNoticeTimer = null;
    this.viewRefreshTimers = new Map();
    this.lastViewRefreshAt = new Map();
    this.workNotesSettingTab = null;

    this.addSettingTab(new WorkNotesSettingTab(this.app, this));
    this.addCommand({
      id: "open-setup-wizard",
      name: "초기 설정 도우미 열기",
      callback: () => this.openSetupWizard()
    });
    this.addCommand({
      id: "create-ticket-note",
      name: "새 CR/SR 티켓 노트 만들기",
      callback: () => new NewTicketModal(this.app, (ticketId) => this.createTicketNote(ticketId)).open()
    });
    this.addCommand({
      id: "set-ticket-status",
      name: "티켓 상태 변경 (SR/CR 자동 분류)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.openStatePicker(file);
        return true;
      }
    });
    this.addCommand({
      id: "open-or-create-work-notes",
      name: "현재 티켓의 ServiceNow 워킹노트 열기/생성",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ticketId = this.ticketIdFromFile(file);
        if (!file || !ticketId) return false;
        if (!checking) this.openOrCreateWorkNotes(file);
        return true;
      }
    });
    this.addCommand({
      id: "refresh-current-work-notes",
      name: "현재 워킹노트 ServiceNow에서 갱신",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ticketId = this.ticketIdFromFile(file, true);
        if (!file || !ticketId) return false;
        if (!checking) this.syncTicket(ticketId, { notify: true });
        return true;
      }
    });
    this.addRibbonIcon("messages-square", "ServiceNow 워킹노트 열기/생성", () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return new Notice("티켓 노트를 먼저 여세요.");
      this.openOrCreateWorkNotes(file);
    });
    this.addRibbonIcon("file-plus-2", "새 CR/SR 티켓 노트 만들기", () => {
      new NewTicketModal(this.app, (ticketId) => this.createTicketNote(ticketId)).open();
    });
    this.addRibbonIcon("list-checks", "티켓 상태 변경", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.openStatePicker(file);
    });
    for (const language of [PLUGIN_ID, LEGACY_PLUGIN_ID]) {
      this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
        const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
        const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
        if (!ticketId) {
          el.createDiv({ cls: "clt-sn-empty", text: "유효한 ticket 번호가 없습니다." });
          return;
        }
        ctx.addChild(new WorkNotesRenderChild(el, this, ticketId));
      });
    }
    this.registerMarkdownCodeBlockProcessor("clt-ticket-status", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      if (!ticketId) {
        el.createDiv({ cls: "clt-sn-empty", text: "유효한 ticket 번호가 없습니다." });
        return;
      }
      ctx.addChild(new TicketStatusRenderChild(el, this, ticketId));
    });
    this.registerMarkdownCodeBlockProcessor("clt-ticket-worklog-actions", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!ticketId || !(file instanceof TFile)) return;
      this.renderTicketSectionAction(el, file, ticketId, "worklog");
    });
    this.registerMarkdownCodeBlockProcessor("clt-ticket-meeting-actions", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!ticketId || !(file instanceof TFile)) return;
      ctx.addChild(new MeetingSectionRenderChild(el, this, ticketId));
    });
    this.registerMarkdownCodeBlockProcessor("clt-ticket-todo-actions", (source, el, ctx) => {
      const configured = source.match(/^ticket:\s*(\S+)\s*$/m)?.[1];
      const ticketId = normalizeTicketId(configured || this.ticketIdFromPath(ctx.sourcePath));
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!ticketId || !(file instanceof TFile)) return;
      this.renderTicketSectionAction(el, file, ticketId, "todo");
    });
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
      if (String(frontmatter.meeting_kind || "").toLowerCase() === "analysis") {
        const headings = [
          ...(el.matches?.("h1, h2, h3, h4, h5, h6") ? [el] : []),
          ...el.querySelectorAll("h1, h2, h3, h4, h5, h6")
        ];
        const actionHeading = headings.find((heading) => /(?:action items|할\s*일|액션\s*아이템)/i.test(String(heading.textContent || "")));
        if (actionHeading && !actionHeading.querySelector(".clt-meeting-action-create")) {
          const button = actionHeading.createEl("button", { cls: "clt-meeting-action-create", text: "＋ To-Do로 만들기", attr: { type: "button" } });
          button.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const markdown = await this.app.vault.cachedRead(file);
            const items = extractMeetingActionItems(markdown);
            if (!items.length) return new Notice("Action Items에서 생성할 할 일을 찾지 못했습니다.");
            new MeetingActionItemsModal(this.app, this, normalizeTicketId(frontmatter.ticket || this.ticketIdFromPath(ctx.sourcePath)), items).open();
          });
        }
      }
      const ticketId = this.rootTicketIdFromFile(file) || this.rootTicketIdFromPathStructure(file);
      if (!ticketId) return;
      const mountTodoBoards = async () => {
        const taskItems = [
          ...(el.matches?.("li.task-list-item") ? [el] : []),
          ...el.querySelectorAll("li.task-list-item")
        ];
        if (!taskItems.length) return;
        const tasks = await this.readTodoTasks(ticketId);
        const matchedItems = taskItems.filter((item) => {
          const rendered = String(item.textContent || "").replace(/\s+/g, " ").trim();
          const dateTime = rendered.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/)?.[0] || "";
          return tasks.some((task) => task.dateTime === dateTime);
        });
        const lists = [...new Set(matchedItems
          .map((item) => item.closest("ul.contains-task-list, ul.task-list"))
          .filter(Boolean))];
        for (const list of lists) this.renderTicketTodoBoard(list, ticketId, tasks);
      };
      const mountWorkLogCards = async () => {
        const markdown = await this.app.vault.cachedRead(file);
        const workLogs = extractTicketWorkLogs(markdown);
        if (!workLogs.length) return;
        const logTimes = new Set(workLogs.map((entry) => entry.dateTime).filter(Boolean));
        const listItems = [
          ...(el.matches?.("li:not(.task-list-item)") ? [el] : []),
          ...el.querySelectorAll("li:not(.task-list-item)")
        ];
        const lists = [...new Set(listItems
          .filter((item) => {
            const dateTime = String(item.textContent || "").match(/\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?/)?.[0] || "";
            return logTimes.has(dateTime);
          })
          .map((item) => item.closest("ul"))
          .filter((list) => list && !list.matches("ul.contains-task-list, ul.task-list")))];
        for (const list of lists) this.renderTicketWorkLogCards(list, ticketId, workLogs, file.path);
      };
      await mountTodoBoards();
      await mountWorkLogCards();
      window.setTimeout(() => mountTodoBoards(), 120);
      window.setTimeout(() => mountWorkLogCards(), 120);
    });
    this.registerDomEvent(document, "click", (event) => {
      this.handleLivePreviewTodoClick(event);
    });

    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!(file instanceof TFile)) return;
      if (file.extension !== "md") {
        window.setTimeout(() => this.onTicketAssetChanged(file), 700);
        return;
      }
      this.pendingNewTicketFiles.add(file.path);
      window.setTimeout(() => this.autoCreateWorkNotesForFile(file), 500);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.pendingNewTicketFiles.delete(oldPath);
      if (!(file instanceof TFile)) return;
      if (file.extension !== "md") {
        window.setTimeout(() => this.onTicketAssetChanged(file), 500);
        return;
      }
      this.pendingNewTicketFiles.add(file.path);
      window.setTimeout(() => this.autoCreateWorkNotesForFile(file), 300);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (this.pendingNewTicketFiles.has(file.path)) this.autoCreateWorkNotesForFile(file);
      this.onTicketMetadataChanged(file);
    }));

    this.app.vault.getMarkdownFiles().forEach((file) => {
      const status = this.app.metadataCache.getFileCache(file)?.frontmatter?.status;
      if (status) this.knownStatus.set(file.path, String(status));
    });

    this.addCommand({
      id: "force-refresh-dashboard",
      name: "업무현황 대시보드를 최신 버전(v2.6.8)으로 갱신",
      callback: async () => {
        try {
          const updated = await this.forceUpgradeDashboard();
          if (updated) {
            new Notice("업무현황 대시보드를 최신 버전(v2.6.8)으로 갱신했습니다.", 6000);
          } else {
            new Notice("업무현황 대시보드가 이미 최신 버전(v2.6.8)입니다.", 5000);
          }
        } catch (error) {
          new Notice(`업무현황 갱신 실패: ${error.message || error}`, 8000);
        }
      }
    });

    const initLayout = async () => {
      await this.ensureWorkspaceScaffold();
      await this.migrateDeploymentFinishFields();
      await this.migrateMeetingParentLinks();
      await this.normalizeTodoMetadataOnce();
      await this.linkExistingLocalBsDocuments();
      await this.repairMalformedRootTickets();
      if (this.settings.autoHolidaySync) {
        window.setTimeout(() => this.syncHolidayCalendar(), 1000);
      }
      window.setTimeout(() => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) this.autoCreateWorkNotesForFile(activeFile, true);
      }, 800);
      window.setTimeout(() => this.ensureStatusBlocksForAllRootTickets(), 1200);
      if (this.settings.autoSync && this.settings.catchUpOnOpen) {
        window.setTimeout(() => this.runCatchUpSync(), 1500);
      }
      if (this.settings.autoStatusSync) {
        window.setTimeout(() => this.runDailyStatusSyncIfDue(), 2200);
      }
      window.setTimeout(() => this.syncUninitializedTickets(), 2800);
      if (Number(this.settings.setupWizardVersion || 0) < FIRST_RUN_SETUP_VERSION) {
        window.setTimeout(() => this.openSetupWizard(), 600);
      }
    };

    if (this.app.workspace.layoutReady) {
      void initLayout();
    } else {
      this.app.workspace.onLayoutReady(initLayout);
    }
    this.registerInterval(window.setInterval(() => this.automationTick(), 60 * 1000));
  }

  onunload() {
    if (this.ticketNoticeTimer) window.clearTimeout(this.ticketNoticeTimer);
    this.viewRefreshTimers?.forEach((timer) => window.clearTimeout(timer));
    this.viewRefreshTimers?.clear();
    if (this.oauthServer) {
      try { this.oauthServer.close(); } catch (_) { /* no-op */ }
    }
    if (this.googleOAuthServer) {
      try { this.googleOAuthServer.close(); } catch (_) { /* no-op */ }
    }
  }

  async savePluginData() {
    await this.saveData({
      settings: this.settings,
      tickets: this.data.tickets,
      todoMetadataVersion: this.data.todoMetadataVersion || 0
    });
  }

  openSetupWizard() {
    new FirstRunSetupModal(this.app, this).open();
  }

  isReadingViewDefault() {
    return this.app.vault.getConfig?.("defaultViewMode") === "preview";
  }

  async setReadingViewDefault(enabled, options = {}) {
    if (typeof this.app.vault.setConfig !== "function") {
      throw new Error("현재 Obsidian 버전에서는 새 탭 기본 화면을 자동으로 변경할 수 없습니다. 설정 → 편집기 → 새 탭 기본 화면에서 직접 변경해 주세요.");
    }
    await Promise.resolve(this.app.vault.setConfig("defaultViewMode", enabled ? "preview" : "source"));
    if (options.notify !== false) {
      new Notice(`새 탭 기본 화면을 ${enabled ? "읽기 화면" : "편집 화면"}으로 변경했습니다. 이미 열린 탭에는 적용되지 않습니다.`, 6000);
    }
  }

  isShowingAllFileTypes() {
    return this.app.vault.getConfig?.("showUnsupportedFiles") === true;
  }

  async setShowAllFileTypes(enabled, options = {}) {
    if (typeof this.app.vault.setConfig !== "function") {
      throw new Error("현재 Obsidian 버전에서는 모든 파일 형식 표시를 자동으로 변경할 수 없습니다. 설정 → 파일 및 링크 → 모든 파일 형식 표시를 직접 켜 주세요.");
    }
    await Promise.resolve(this.app.vault.setConfig("showUnsupportedFiles", Boolean(enabled)));
    if (options.notify !== false) {
      new Notice(`모든 파일 형식 표시를 ${enabled ? "활성화" : "비활성화"}했습니다.`, 5000);
    }
  }

  queueTicketChangeNotice({ kind = "other", ticketId = "", message = "", failed = false, duration = 7000 }) {
    this.ticketNoticeQueue.push({ kind, ticketId, message, failed, duration });
    if (this.ticketNoticeTimer) window.clearTimeout(this.ticketNoticeTimer);
    this.ticketNoticeTimer = window.setTimeout(() => this.flushTicketChangeNotices(), 7000);
  }

  flushTicketChangeNotices() {
    const entries = this.ticketNoticeQueue.splice(0);
    this.ticketNoticeTimer = null;
    if (!entries.length) return;
    if (entries.length < 3) {
      for (const entry of entries) new Notice(entry.message, entry.duration);
      return;
    }
    new Notice(summarizeTicketNotices(entries), 9000);
  }

  getSecret(key) {
    return this.app.secretStorage?.getSecret?.(key) || "";
  }

  setSecret(key, value) {
    if (!this.app.secretStorage?.setSecret) {
      throw new Error("현재 Obsidian 버전에서 SecretStorage를 사용할 수 없습니다. Obsidian을 업데이트하세요.");
    }
    this.app.secretStorage.setSecret(key, value || "");
  }

  deleteSecret(key) {
    if (this.app.secretStorage?.deleteSecret) this.app.secretStorage.deleteSecret(key);
    else if (this.app.secretStorage?.setSecret) this.app.secretStorage.setSecret(key, "");
  }

  migrateLegacySecrets() {
    const pairs = [
      [`${LEGACY_PLUGIN_ID}-access-token`, ACCESS_TOKEN_KEY],
      [`${LEGACY_PLUGIN_ID}-refresh-token`, REFRESH_TOKEN_KEY],
      [`${LEGACY_PLUGIN_ID}-google-access-token`, GOOGLE_ACCESS_TOKEN_KEY],
      [`${LEGACY_PLUGIN_ID}-google-refresh-token`, GOOGLE_REFRESH_TOKEN_KEY],
      [`${LEGACY_PLUGIN_ID}-google-client-secret`, GOOGLE_CLIENT_SECRET_KEY]
    ];
    for (const [legacyKey, currentKey] of pairs) {
      const legacyValue = this.getSecret(legacyKey);
      if (legacyValue && !this.getSecret(currentKey)) this.setSecret(currentKey, legacyValue);
    }
  }

  registerView(ticketId, view) {
    if (!this.views.has(ticketId)) this.views.set(ticketId, new Set());
    this.views.get(ticketId).add(view);
  }

  unregisterView(ticketId, view) {
    this.views.get(ticketId)?.delete(view);
  }

  refreshViews(ticketId) {
    this.views.get(ticketId)?.forEach((view) => view.render());
  }

  scheduleViewRefresh(ticketId, kind) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) return;
    const key = `${kind}:${normalized}`;
    const previousTimer = this.viewRefreshTimers.get(key);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      this.viewRefreshTimers.delete(key);
      const now = Date.now();
      const lastRefresh = Number(this.lastViewRefreshAt.get(key) || 0);
      if (now - lastRefresh < 60 * 1000) return;
      this.lastViewRefreshAt.set(key, now);
      if (kind === "work-notes") void this.syncTicket(normalized);
      else void this.syncTicketStatus(normalized);
    }, 300);
    this.viewRefreshTimers.set(key, timer);
  }

  ticketIdFromPath(path) {
    const match = String(path || "").toUpperCase().match(/(?:^|\/)((?:CR|SR|INC)\d+)(?:\s+워킹노트)?\.MD$/);
    return match ? match[1] : "";
  }

  ticketIdFromFile(file, allowWorkNotes = false) {
    if (!(file instanceof TFile) || file.extension !== "md") return "";
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const fromTicket = normalizeTicketId(fm.ticket);
    if (allowWorkNotes && fromTicket) return fromTicket;
    const fromId = normalizeTicketId(fm.id);
    if (fromId) return fromId;
    return normalizeTicketId(file.basename.replace(/\s+워킹노트$/, ""));
  }

  async ensureFolder(path) {
    const normalized = normalizePath(path || "");
    if (!normalized || this.app.vault.getAbstractFileByPath(normalized)) return;
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  rootFolder() {
    return normalizePath(String(this.settings.rootFolder || "ServiceNow").trim() || "ServiceNow");
  }

  ticketsFolder() {
    return normalizePath(`${this.rootFolder()}/티켓`);
  }

  ticketFolder(ticketId) {
    return normalizePath(`${this.ticketsFolder()}/${normalizeTicketId(ticketId)}`);
  }

  templateFolder() {
    return normalizePath(`${this.rootFolder()}/Templates`);
  }

  ticketTemplatePath() {
    return normalizePath(`${this.templateFolder()}/티켓 템플릿.md`);
  }

  workNotesTemplatePath() {
    return normalizePath(`${this.templateFolder()}/워킹노트 템플릿.md`);
  }

  aiPromptTemplatePath() {
    return normalizePath(`${this.rootFolder()}/지침/AI 내용.md`);
  }

  analysisTemplatePath(category) {
    const type = String(category || "").toUpperCase() === "SR" ? "SR" : "CR";
    return normalizePath(`${this.rootFolder()}/지침/${type}_TEMPLATE.md`);
  }

  absoluteVaultPath(vaultPath) {
    const relative = String(vaultPath || "");
    const base = typeof this.app.vault.adapter.getBasePath === "function"
      ? String(this.app.vault.adapter.getBasePath() || "")
      : "";
    if (!base) return relative;
    const separator = base.includes("\\") ? "\\" : "/";
    return `${base.replace(/[\\/]+$/, "")}${separator}${relative.replace(/[\\/]+/g, separator)}`;
  }

  documentsFolder() {
    return normalizePath(`${this.rootFolder()}/문서`);
  }

  ticketDocumentsFolder(ticketId) {
    return normalizePath(`${this.documentsFolder()}/${normalizeTicketId(ticketId)}`);
  }

  ticketAssetsFolder(ticketId) {
    return normalizePath(`${this.ticketFolder(ticketId)}/assets`);
  }

  ticketMeetingsFolder(ticketId) {
    return normalizePath(`${this.ticketFolder(ticketId)}/회의록`);
  }

  generalMeetingsFolder() {
    return normalizePath(`${this.rootFolder()}/회의록`);
  }

  dashboardPath() {
    return normalizePath(`${this.rootFolder()}/업무현황.md`);
  }

  async readBundledDashboard() {
    if (EMBEDDED_DASHBOARD_GZIP_BASE64) {
      try {
        return zlib.gunzipSync(Buffer.from(EMBEDDED_DASHBOARD_GZIP_BASE64, "base64")).toString("utf8");
      } catch (error) {
        console.error("[ServiceNow Manage] 내장 업무현황 데이터 해제 실패", error);
      }
    }
    const configDir = this.app.vault.configDir || ".obsidian";
    const path = normalizePath(`${configDir}/plugins/${PLUGIN_ID}/업무현황.md`);
    try {
      return await this.app.vault.adapter.read(path);
    } catch (error) {
      console.error("[ServiceNow Manage] 내장 업무현황 템플릿 읽기 실패", error);
      return "";
    }
  }

  async ensureWorkspaceScaffold() {
    await this.ensureFolder(this.ticketsFolder());
    await this.ensureTicketAssetFolders();
    await this.ensureFolder(this.templateFolder());
    await this.ensureFolder(normalizePath(`${this.rootFolder()}/지침`));
    if (!this.app.vault.getAbstractFileByPath(this.ticketTemplatePath())) {
      await this.app.vault.create(this.ticketTemplatePath(), defaultTicketTemplate());
    }
    await this.ensureTicketTemplateFields();
    if (!this.app.vault.getAbstractFileByPath(this.workNotesTemplatePath())) {
      await this.app.vault.create(this.workNotesTemplatePath(), defaultWorkNotesTemplate());
    }
    if (this.settings.organizationFeaturesEnabled && this.hasOrganizationPack()) {
      await this.ensureOrganizationTemplates();
    }
    if (!this.app.vault.getAbstractFileByPath(this.dashboardPath())) {
      const bundled = await this.readBundledDashboard();
      if (bundled) {
        const dashboard = bundled.replaceAll("__SERVICENOW_ROOT_FOLDER__", this.rootFolder());
        await this.app.vault.create(this.dashboardPath(), dashboard);
      } else {
        new Notice("업무현황 내장 템플릿을 읽지 못했습니다. 플러그인을 다시 설치해 주세요.", 9000);
      }
    }
    await this.ensureDashboardRuntime();
    await this.ensureDashboardPopupFieldGrid();
    await this.ensureDashboardTodoCreation();
    await this.ensureDashboardControlVisibility();
    await this.ensureDashboardTodoDetails();
    await this.ensureDashboardTodoSummaryColumn();
    await this.ensureDashboardSharedTodoModal();
    await this.ensureDashboardFieldOrdering();
    await this.ensureDashboardTodoPagination();
    await this.savePluginData();
  }

  async ensureDashboardRuntime() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    const configured = bundled.replaceAll("__SERVICENOW_ROOT_FOLDER__", this.rootFolder());
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardRuntime(markdown, configured)
    );
  }

  async forceUpgradeDashboard() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) throw new Error(`${this.dashboardPath()} 파일을 찾을 수 없습니다.`);
    const bundled = await this.readBundledDashboard();
    if (!bundled) throw new Error("내장 업무현황 템플릿을 읽을 수 없습니다.");
    const configured = bundled.replaceAll("__SERVICENOW_ROOT_FOLDER__", this.rootFolder());
    let updated = false;
    await this.app.vault.process(dashboard, (markdown) => {
      const next = upgradeDashboardRuntime(markdown, configured);
      if (next !== markdown) updated = true;
      return next;
    });
    return updated;
  }

  async ensureDashboardPopupFieldGrid() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    await this.app.vault.process(dashboard, upgradeDashboardPopupFieldGrid);
  }

  async ensureDashboardTodoCreation() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardTodoCreation(markdown, bundled)
    );
  }

  async ensureDashboardControlVisibility() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardControlVisibility(markdown, bundled)
    );
  }

  async ensureDashboardTodoDetails() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardTodoDetails(markdown, bundled)
    );
  }

  async ensureDashboardTodoSummaryColumn() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardTodoSummaryColumn(markdown, bundled)
    );
  }

  async ensureDashboardSharedTodoModal() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardSharedTodoModal(markdown, bundled)
    );
  }

  async ensureDashboardFieldOrdering() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardFieldOrdering(markdown, bundled)
    );
  }

  async ensureDashboardTodoPagination() {
    const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
    if (!(dashboard instanceof TFile)) return;
    const bundled = await this.readBundledDashboard();
    if (!bundled) return;
    await this.app.vault.process(
      dashboard,
      (markdown) => upgradeDashboardTodoPagination(markdown, bundled)
    );
  }

  async ensureTicketAssetFolders() {
    const tickets = this.app.vault.getAbstractFileByPath(this.ticketsFolder());
    const folders = Array.isArray(tickets?.children)
      ? tickets.children.filter((entry) => /^(?:CR|SR)\d+$/i.test(entry.name || ""))
      : [];
    for (const folder of folders) {
      await this.ensureFolder(normalizePath(`${folder.path}/assets`));
      await this.ensureFolder(normalizePath(`${folder.path}/회의록`));
    }
  }

  async readTemplate(path, fallback) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.app.vault.read(file) : fallback;
  }

  async ensureTicketTemplateFields() {
    const file = this.app.vault.getAbstractFileByPath(this.ticketTemplatePath());
    if (!(file instanceof TFile)) return;
    const required = [
      "short_description", "service_now_priority", "ticket_creator", "ticket_requester", "service_now_created",
      "assignment_group", "assigned_person", "service_now_category", "service_now_updated",
      "estimated_qa_completion_date", "target_qa_completion_date", "actual_release_date",
      "배포일", "ui_interface_id", "BS-한글"
    ];
    await this.app.vault.process(file, (markdown) => {
      let next = repairTemplatePlaceholders(markdown);
      const match = next.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---/);
      if (!match) return next;
      const existing = new Set([...match[2].matchAll(/^([^\s:#][^:]*):/gm)].map((item) => item[1].trim()));
      const missing = required.filter((key) => !existing.has(key));
      if (missing.length) {
        const additions = missing.map((key) => `${key}:`).join(match[1]);
        next = next.replace(match[0], `${match[0].slice(0, -3)}${match[1]}${additions}${match[1]}---`);
      }
      next = next.replace(/^deployment_finish:[^\r\n]*(?:\r?\n|$)/m, "");
      next = next.replace(/(^##[^\r\n]*To-Do[^\r\n]*\r?\n(?:\r?\n)*)(?:- \[ \][ \t]*(?:\r?\n|$))/mi, "$1");
      next = ensureSectionActionBlock(next, "{{ticketId}}", "📝 작업 일지", "clt-ticket-worklog-actions");
      next = ensureSectionActionBlock(next, "{{ticketId}}", "🗓️ 회의록", "clt-ticket-meeting-actions");
      return ensureSectionActionBlock(next, "{{ticketId}}", "✅ To-Do", "clt-ticket-todo-actions");
    });
  }

  async createTicketNote(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized || !/^(CR|SR)/.test(normalized)) return new Notice("올바른 CR/SR 티켓 번호가 아닙니다.");
    await this.ensureWorkspaceScaffold();
    const category = normalized.slice(0, 2);
    const folder = normalizePath(`${this.ticketsFolder()}/${normalized}`);
    const path = normalizePath(`${folder}/${normalized}.md`);
    await this.ensureFolder(folder);
    await this.ensureFolder(this.ticketAssetsFolder(normalized));
    await this.ensureFolder(this.ticketMeetingsFolder(normalized));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(existing);
      return new Notice(`${normalized} 티켓 노트가 이미 있어 기존 노트를 열었습니다.`);
    }
    const template = repairTemplatePlaceholders(
      await this.readTemplate(this.ticketTemplatePath(), defaultTicketTemplate())
    );
    const now = localIsoDateTime().replace(" ", "T").slice(0, 16);
    const file = await this.app.vault.create(path, fillTemplate(template, {
      ticketId: normalized,
      category,
      now
    }));
    this.autoLinking.add(file.path);
    try {
      await this.ensureRootTicketIdentity(file, normalized, category, now);
      await this.app.workspace.getLeaf(false).openFile(file);
      const synced = await this.initializeNewTicket(file, normalized);
      new Notice(synced
        ? `${normalized} 티켓 생성과 ServiceNow 최초 동기화를 완료했습니다.`
        : `${normalized} 티켓은 만들었지만 ServiceNow 최초 동기화에 실패했습니다. 티켓의 갱신 버튼으로 다시 시도해 주세요.`,
      8000);
    } finally {
      this.pendingNewTicketFiles.delete(file.path);
      this.autoLinking.delete(file.path);
    }
  }

  requestRootFolderChange(value, onDone) {
    const next = normalizePath(String(value || "").trim() || "ServiceNow");
    const current = this.rootFolder();
    if (next === current) return new Notice("현재 루트 폴더와 같습니다.");
    const targetExists = Boolean(this.app.vault.getAbstractFileByPath(next));
    const message = targetExists
      ? `${current}/티켓과 ${next}/티켓을 비교해 ${next}에 없는 티켓 폴더만 이동합니다. 같은 티켓은 양쪽 모두 그대로 유지합니다. 계속할까요?`
      : `${current} 폴더 전체를 ${next}(으)로 이동합니다. Obsidian이 내부 링크도 함께 갱신합니다. 계속할까요?`;
    new ConfirmActionModal(
      this.app,
      "루트 폴더 변경",
      message,
      async () => {
        await this.changeRootFolder(next);
        onDone?.();
      }
    ).open();
  }

  async changeRootFolder(nextRoot) {
    const current = this.rootFolder();
    const next = normalizePath(String(nextRoot || "").trim() || "ServiceNow");
    const currentFolder = this.app.vault.getAbstractFileByPath(current);
    const target = this.app.vault.getAbstractFileByPath(next);
    const parent = next.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    let movedTickets = 0;
    let skippedTickets = 0;
    if (target && target !== currentFolder) {
      const currentTicketsPath = normalizePath(`${current}/티켓`);
      const nextTicketsPath = normalizePath(`${next}/티켓`);
      await this.ensureFolder(nextTicketsPath);
      const currentTickets = this.app.vault.getAbstractFileByPath(currentTicketsPath);
      const ticketFolders = Array.isArray(currentTickets?.children)
        ? [...currentTickets.children].filter((child) => /^(CR|SR)\d+$/i.test(child.name || ""))
        : [];
      for (const ticketFolder of ticketFolders) {
        const destination = normalizePath(`${nextTicketsPath}/${ticketFolder.name}`);
        if (this.app.vault.getAbstractFileByPath(destination)) {
          skippedTickets++;
          continue;
        }
        await this.app.fileManager.renameFile(ticketFolder, destination);
        movedTickets++;
      }
    } else if (currentFolder) {
      await this.app.fileManager.renameFile(currentFolder, next);
    }
    if (this.settings.workNotesFolder === current || this.settings.workNotesFolder?.startsWith(`${current}/`)) {
      this.settings.workNotesFolder = `${next}${this.settings.workNotesFolder.slice(current.length)}`;
    }
    this.settings.rootFolder = next;
    const dashboard = this.app.vault.getAbstractFileByPath(normalizePath(`${next}/업무현황.md`));
    if (dashboard instanceof TFile) {
      await this.app.vault.process(dashboard, (markdown) => markdown.replace(
        /const ROOT_FOLDER = "[^"]*";/,
        `const ROOT_FOLDER = "${next.replaceAll('"', '\\"')}";`
      ));
    }
    await this.ensureWorkspaceScaffold();
    const result = target && target !== currentFolder
      ? `루트 폴더를 ${next}(으)로 변경했습니다. · 티켓 이동 ${movedTickets}개 · 중복 유지 ${skippedTickets}개`
      : `루트 폴더를 ${next}(으)로 이동했습니다.`;
    new Notice(result, 9000);
  }

  requestWorkNotesFolderChange(value, onDone) {
    const next = normalizePath(String(value || "").trim());
    const current = normalizePath(this.settings.workNotesFolder || "");
    if (next === current) return new Notice("현재 워킹노트 폴더 설정과 같습니다.");
    const count = this.workNotesFiles().length;
    const destination = next || "각 티켓 노트 폴더";
    new ConfirmActionModal(
      this.app,
      "워킹노트 폴더 이동",
      `워킹노트 ${count}개를 ${destination}(으)로 이동하고 설정을 변경합니다. 계속할까요?`,
      async () => {
        await this.changeWorkNotesFolder(next);
        onDone?.();
      }
    ).open();
  }

  workNotesFiles() {
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return String(fm.category || "").toLowerCase() === "work notes" && normalizeTicketId(fm.ticket);
    });
  }

  async changeWorkNotesFolder(nextFolder) {
    const next = normalizePath(String(nextFolder || "").trim());
    if (next) await this.ensureFolder(next);
    const moves = [];
    for (const file of this.workNotesFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const ticketId = normalizeTicketId(fm.ticket);
      const rootFile = this.rootTicketFile(ticketId);
      if (!rootFile) continue;
      const destinationFolder = next || rootFile.parent?.path || "";
      const destination = normalizePath(`${destinationFolder ? `${destinationFolder}/` : ""}${file.name}`);
      if (destination === file.path) continue;
      const conflict = this.app.vault.getAbstractFileByPath(destination);
      if (conflict && conflict !== file) throw new Error(`${destination} 파일이 이미 있습니다.`);
      moves.push([file, destination]);
    }
    for (const [file, destination] of moves) await this.app.fileManager.renameFile(file, destination);
    this.settings.workNotesFolder = next;
    await this.savePluginData();
    new Notice(`워킹노트 ${moves.length}개를 이동했습니다.`, 7000);
  }

  openTranslateSetup() {
    const installed = this.app.plugins?.plugins?.translate;
    if (installed) {
      this.app.setting?.open?.();
      this.app.setting?.openTabById?.("translate");
      return;
    }
    shell.openExternal("obsidian://show-plugin?id=translate");
  }

  openDataviewSetup() {
    const installed = this.app.plugins?.plugins?.dataview;
    if (installed) {
      this.app.setting?.open?.();
      this.app.setting?.openTabById?.("dataview");
      return;
    }
    shell.openExternal("obsidian://show-plugin?id=dataview");
  }

  holidaySet() {
    const manual = String(this.settings.koreanHolidays || "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
    const automatic = Object.values(this.settings.holidayCache || {})
      .flat()
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
    return new Set([...automatic, ...manual]);
  }

  async fetchPublicHolidays(year) {
    const response = await requestUrl({
      url: `https://date.nager.at/api/v4/Holidays/KR/${year}`,
      method: "GET",
      headers: { Accept: "application/json" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300 || !Array.isArray(response.json)) {
      throw new Error(`공휴일 API HTTP ${response.status}`);
    }
    return [...new Set(response.json
      .filter((holiday) => holiday?.nationalHoliday !== false)
      .filter((holiday) => !Array.isArray(holiday?.holidayTypes) || holiday.holidayTypes.includes("Public"))
      .map((holiday) => String(holiday?.date || "").slice(0, 10))
      .filter((date) => date.startsWith(`${year}-`) && /^\d{4}-\d{2}-\d{2}$/.test(date)))]
      .sort();
  }

  async syncHolidayCalendar(options = {}) {
    if (!this.settings.autoHolidaySync && !options.force) return;
    const today = localIsoDate();
    if (!options.force && this.settings.lastHolidaySyncDate === today) return;
    const currentYear = new Date().getFullYear();
    const years = [currentYear, currentYear + 1];
    const previous = this.settings.holidayCache || {};
    const nextCache = {};
    const failures = [];
    for (const year of years) {
      try {
        nextCache[year] = await this.fetchPublicHolidays(year);
      } catch (error) {
        failures.push(`${year}: ${error.message || error}`);
        if (Array.isArray(previous[year])) nextCache[year] = previous[year];
      }
    }
    this.settings.holidayCache = nextCache;
    if (!failures.length) this.settings.lastHolidaySyncDate = today;
    await this.savePluginData();
    if (options.notify) {
      const count = Object.values(nextCache).reduce((sum, dates) => sum + dates.length, 0);
      new Notice(failures.length
        ? `공휴일 갱신 일부 실패 · 기존 자료 유지\n${failures.join("\n")}`
        : `공휴일 갱신 완료 · ${years.join("·")}년 ${count}일`, 9000);
    }
  }

  serviceNowTableForTicket(ticketId) {
    return tableForTicket(ticketId, {
      CR: this.settings.changeRequestTable || "change_request",
      SR: this.settings.serviceRequestTable || "u_service_call",
      IN: this.settings.incidentTable || "incident"
    });
  }

  stateOptions(category) {
    const configured = this.settings.organizationFeaturesEnabled
      ? this.organizationPack?.states?.[category]
      : null;
    if (Array.isArray(configured) && configured.length) return configured.map(String);
    return category === "CR" ? CR_STATES : category === "SR" ? SR_STATES : [];
  }

  canonicalStatus(category, status) {
    const allowed = this.stateOptions(category);
    const value = String(status || "").trim();
    return allowed.find((item) => item.toLowerCase() === value.toLowerCase()) || value;
  }

  async openStatePicker(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const category = String(fm.category || "").toUpperCase();
    if (!["CR", "SR"].includes(category)) return new Notice("먼저 category를 CR 또는 SR로 설정하세요.");
    new StateModal(this.app, this.stateOptions(category),
      (state) => this.applyStatus(file, category, state)).open();
  }

  async onTicketMetadataChanged(file) {
    if (!(file instanceof TFile) || this.updatingStatus.has(file.path)) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    if (!fm.status || !this.rootTicketIdFromFile(file)) return;
    const status = String(fm.status);
    const previous = this.knownStatus.get(file.path);
    this.knownStatus.set(file.path, status);
    if (previous !== undefined && previous !== status) {
      await this.applyStatus(file, String(fm.category || "").toUpperCase(), status, {
        noticeMode: "batch"
      });
    }
  }

  resolveSla(category, status, fm) {
    if (!this.organizationFeatureEnabled("slaRules")) return null;
    const configured = this.organizationPack?.slaRules?.[category]?.[status];
    if (!configured) return CR_SLA[status] || null;
    if (Array.isArray(configured)) return configured;
    if (configured.rule && configured.frontmatter) {
      const current = String(fm[configured.frontmatter] || "").toLowerCase();
      return current === String(configured.equals || "").toLowerCase() ? configured.rule : null;
    }
    const priority = String(fm.service_now_priority || fm.priority || "").toLowerCase();
    const purpose = String(fm.purpose || "").toUpperCase().match(/^[A-Z]+/)?.[0] || "";
    return configured.priority?.[priority] || configured.purpose?.[purpose] || null;
  }

  async applyStatus(file, category, status, options = {}) {
    const allowed = this.stateOptions(category);
    const normalizedStatus = this.canonicalStatus(category, status);
    if (!options.allowUnknown && !allowed.includes(normalizedStatus)) {
      return new Notice(`${category || "미분류"}에서 사용할 수 없는 상태입니다.`);
    }
    this.updatingStatus.add(file.path);
    try {
      let dueMessage = "고정 SLA가 없어 작업예정일은 유지했습니다.";
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.status = normalizedStatus;
        fm.status_changed = localIsoDate();
        const sla = this.resolveSla(category, normalizedStatus, fm);
        if (!sla) return;
        const [kind, count, basis] = sla;
        const due = kind === "working"
          ? addWorkingDays(new Date(), count, this.holidaySet())
          : addCalendarDays(new Date(), count);
        fm["작업예정일"] = localIsoDate(due);
        fm.sla_basis = basis;
        dueMessage = `작업예정일: ${fm["작업예정일"]} (${basis})`;
      });
      this.knownStatus.set(file.path, normalizedStatus);
      if (options.notify !== false) {
        const message = `${normalizedStatus}\n${dueMessage}`;
        if (options.noticeMode === "batch") {
          this.queueTicketChangeNotice({
            kind: "status",
            ticketId: this.rootTicketIdFromFile(file),
            message,
            duration: 6000
          });
        } else {
          new Notice(message, 6000);
        }
      }
    } finally {
      window.setTimeout(() => this.updatingStatus.delete(file.path), 300);
    }
  }

  async applyExternalStatus(file, status) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const category = String(fm.category || "").toUpperCase();
    return this.applyStatus(file, category, this.canonicalStatus(category, status), {
      allowUnknown: true,
      notify: false
    });
  }

  async resolveExistingWorkNotes(parentFile, frontmatter) {
    const linkPath = parseWikiLink(frontmatter?.["워킹노트"]);
    if (!linkPath) return null;
    const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, parentFile.path);
    return resolved instanceof TFile ? resolved : null;
  }

  rootTicketIdFromFile(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return "";
    const path = normalizePath(file.path);
    const prefix = `${this.ticketsFolder()}/`;
    if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return "";
    const match = path.slice(prefix.length).match(/^((?:CR|SR)\d+)\/\1\.md$/i);
    if (!match) return "";
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const ticketId = normalizeTicketId(fm.id);
    const category = String(fm.category || "").toUpperCase();
    return ticketId === match[1].toUpperCase() && ticketId.startsWith(category) ? ticketId : "";
  }

  rootTicketIdFromPathStructure(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return "";
    const path = normalizePath(file.path);
    const prefix = `${this.ticketsFolder()}/`;
    if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return "";
    const match = path.slice(prefix.length).match(/^((?:CR|SR)\d+)\/\1\.md$/i);
    return match ? match[1].toUpperCase() : "";
  }

  async ensureRootTicketIdentity(file, ticketId, category = ticketId.slice(0, 2), now = "") {
    let changed = false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (normalizeTicketId(frontmatter.id) !== ticketId) {
        frontmatter.id = ticketId;
        changed = true;
      }
      if (String(frontmatter.category || "").toUpperCase() !== category) {
        frontmatter.category = category;
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(frontmatter, "BS-한글")) {
        frontmatter["BS-한글"] = "";
        changed = true;
      }
      for (const field of ["created", "updated"]) {
        const value = frontmatter[field];
        const malformed = value && typeof value === "object";
        if ((value === undefined || value === null || value === "" || malformed) && now) {
          frontmatter[field] = now;
          changed = true;
        }
      }
    });
    return changed;
  }

  async migrateDeploymentFinishFields() {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.rootTicketIdFromPathStructure(file)) continue;
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        mergeDeploymentFinishField(frontmatter);
      });
    }
  }

  async migrateMeetingParentLinks() {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.includes("/회의록/"));
    for (const file of files) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      if (String(frontmatter.type || "") !== "meeting-minutes" || frontmatter.Parent) continue;
      const ticketId = normalizeTicketId(frontmatter.ticket || this.ticketIdFromPath(file.path));
      if (!ticketId) continue;
      await this.app.fileManager.processFrontMatter(file, (current) => {
        if (!current.Parent) current.Parent = `[[${ticketId}]]`;
      });
    }
  }

  async repairMalformedRootTickets() {
    const candidates = this.app.vault.getMarkdownFiles()
      .map((file) => ({ file, ticketId: this.rootTicketIdFromPathStructure(file) }))
      .filter((item) => item.ticketId);
    for (const { file, ticketId } of candidates) {
      await this.ensureRootTicketIdentity(
        file,
        ticketId,
        ticketId.slice(0, 2),
        localIsoDateTime().replace(" ", "T").slice(0, 16)
      );
      if (!this.data.tickets[ticketId]?.lastSyncedAt) {
        await this.initializeNewTicket(file, ticketId);
      }
    }
  }

  rootTicketFiles() {
    return this.app.vault.getMarkdownFiles().filter((file) => this.rootTicketIdFromFile(file));
  }

  rootTicketFile(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    return this.rootTicketFiles().find((file) => this.rootTicketIdFromFile(file) === normalized) || null;
  }

  listTicketMeetings(ticketId, sortDirection = "desc") {
    const folder = `${this.ticketMeetingsFolder(ticketId)}/`;
    const meetings = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(folder))
      .map((file) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const meetingDate = String(frontmatter.meeting_date || "");
        return {
          ticketId: normalizeTicketId(ticketId),
          file,
          title: file.basename.replace(/^\d{4}-\d{2}-\d{2}[ T_-]*\d{0,2}[-:]?\d{0,2}\s*-?\s*/, "") || file.basename,
          meetingDate,
          meetingStart: String(frontmatter.meeting_start || ""),
          meetingEnd: String(frontmatter.meeting_end || ""),
          sourceName: String(frontmatter.source_name || ""),
          sourceDriveId: String(frontmatter.source_drive_id || ""),
          sourcePdf: parseWikiLink(frontmatter.source_pdf || ""),
          kind: String(frontmatter.meeting_kind || "gemini").toLowerCase()
        };
      });
    meetings.sort((left, right) => {
      const compared = String(left.meetingDate || left.file.stat.ctime).localeCompare(String(right.meetingDate || right.file.stat.ctime));
      return sortDirection === "asc" ? compared : -compared;
    });
    return meetings;
  }

  latestMeetingAnalysis(ticketId) {
    return this.listTicketMeetings(ticketId, "desc")
      .filter((meeting) => meeting.kind === "analysis")
      .sort((left, right) => {
        const leftEnd = String(left.meetingEnd || left.meetingDate || "");
        const rightEnd = String(right.meetingEnd || right.meetingDate || "");
        return rightEnd.localeCompare(leftEnd) || right.file.stat.mtime - left.file.stat.mtime;
      })[0] || null;
  }

  meetingCoveredByAnalysis(meeting, analysis) {
    const meetingDate = String(meeting?.meetingDate || "");
    const analysisEnd = String(analysis?.meetingEnd || analysis?.meetingDate || "");
    return Boolean(meetingDate && analysisEnd && meetingDate.slice(0, 10) <= analysisEnd.slice(0, 10));
  }

  renderMeetingCards(container, meetings, { emptyText = "등록된 회의록이 없습니다." } = {}) {
    container.empty?.();
    if (!meetings.length) {
      container.createDiv({ cls: "clt-meeting-empty", text: emptyText });
      return;
    }
    for (const meeting of meetings) {
      const card = container.createDiv({ cls: `clt-meeting-card${meeting.kind === "analysis" ? " is-analysis" : ""}` });
      const open = card.createEl("button", { cls: "clt-meeting-card-open", attr: { type: "button", title: `${meeting.title} 열기` } });
      const date = String(meeting.meetingDate || "").replace("T", " ") || "일시 미지정";
      const heading = open.createDiv({ cls: "clt-meeting-card-heading" });
      heading.createDiv({ cls: "clt-meeting-card-date", text: date });
      heading.createSpan({
        cls: `clt-meeting-type-badge ${meeting.kind === "analysis" ? "is-analysis" : "is-gemini"}`,
        text: meeting.kind === "analysis" ? "AI 회의록 분석" : "Gemini 회의록"
      });
      open.createDiv({ cls: "clt-meeting-card-title", text: meeting.title });
      const meta = open.createDiv({ cls: "clt-meeting-card-meta" });
      meta.createSpan({ text: meeting.sourceName || (meeting.kind === "analysis" ? "AI 분석" : "회의록") });
      open.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.app.workspace.getLeaf(false).openFile(meeting.file);
      });
      const remove = card.createEl("button", {
        cls: "clt-meeting-card-delete",
        text: "×",
        attr: { type: "button", title: "회의록 삭제", "aria-label": `${meeting.title} 삭제` }
      });
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        new ConfirmActionModal(
          this.app,
          "회의록 삭제",
          `'${meeting.title}'을 Obsidian에서 삭제하시겠습니까? Google Drive 원본은 삭제되지 않습니다.`,
          async () => {
            await this.deleteTicketMeeting(meeting);
            container.dispatchEvent(new CustomEvent("clt-meeting-deleted", { bubbles: true }));
          },
          "삭제",
          "회의록 삭제"
        ).open();
      });
    }
  }

  renderTicketMeetingSection(el, ticketId) {
    el.addClass("clt-ticket-meeting-action");
    el.closest(".markdown-preview-view, .markdown-rendered")?.classList.add("clt-ticket-note-render");
    const toolbar = el.createDiv({ cls: "clt-meeting-inline-toolbar" });
    const count = toolbar.createSpan({ cls: "clt-meeting-list-count" });
    const actions = toolbar.createDiv({ cls: "clt-meeting-list-actions" });
    const sort = actions.createEl("button", { text: "최신순 ↓", attr: { type: "button" } });
    const filter = actions.createEl("details", { cls: "clt-meeting-label-filter" });
    filter.createEl("summary", { text: "라벨 필터" });
    const filterMenu = filter.createDiv({ cls: "clt-meeting-label-filter-menu" });
    const selectedKinds = new Set(["gemini", "analysis"]);
    const labels = new Map([["gemini", "Gemini 회의록"], ["analysis", "AI 회의록 분석"]]);
    for (const [kind, label] of labels) {
      const option = filterMenu.createEl("label");
      const checkbox = option.createEl("input", { type: "checkbox" });
      checkbox.checked = true;
      option.createSpan({ text: label });
      checkbox.addEventListener("change", () => {
        checkbox.checked ? selectedKinds.add(kind) : selectedKinds.delete(kind);
        refresh();
      });
    }
    const drive = actions.createEl("button", { text: "Drive에서 가져오기", attr: { type: "button" } });
    const reload = actions.createEl("button", { text: "새로고침", attr: { type: "button", title: "회의록 목록 새로고침" } });
    const add = actions.createEl("button", { text: "＋ 파일로 추가", cls: "mod-cta", attr: { type: "button" } });
    const list = el.createDiv({ cls: "clt-meeting-list" });
    let direction = "desc";
    const refresh = () => {
      const allMeetings = this.listTicketMeetings(ticketId, direction);
      const meetings = allMeetings.filter((meeting) => selectedKinds.has(meeting.kind));
      count.setText(`${meetings.length}개의 회의 기록${meetings.length !== allMeetings.length ? ` · 전체 ${allMeetings.length}개` : ""}`);
      sort.setText(direction === "desc" ? "최신순 ↓" : "오래된순 ↑");
      list.dataset.sortDirection = direction;
      this.renderMeetingCards(list, meetings);
    };
    sort.addEventListener("click", () => {
      direction = direction === "desc" ? "asc" : "desc";
      refresh();
    });
    add.addEventListener("click", () => new MeetingImportModal(this.app, this, ticketId, refresh).open());
    drive.addEventListener("click", () => new DriveMeetingCandidateModal(this.app, this, ticketId, refresh).open());
    reload.addEventListener("click", refresh);
    list.addEventListener("clt-meeting-deleted", refresh);
    refresh();
  }

  openMeetingImportModal(ticketId, onImported = null) {
    new MeetingImportModal(this.app, this, ticketId, onImported).open();
  }

  openGlobalMeetingImportModal(onImported = null) {
    new MeetingImportModal(this.app, this, "", onImported, true).open();
  }

  openGlobalDriveMeetingModal(onImported = null) {
    new GlobalDriveMeetingTicketModal(this.app, this, onImported).open();
  }

  openMeetingListModal(ticketId) {
    new MeetingListModal(this.app, this, ticketId).open();
  }

  openDriveMeetingCandidateModal(ticketId, onImported = null) {
    new DriveMeetingCandidateModal(this.app, this, ticketId, onImported).open();
  }

  openMeetingAnalysisPromptModal(ticketId) {
    new MeetingAnalysisPromptModal(this.app, this, ticketId).open();
  }

  async generateMeetingAnalysisPrompt(ticketId, meetings, { useBaseline = false } = {}) {
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    const baseline = useBaseline ? this.latestMeetingAnalysis(normalized) : null;
    const inputMeetings = baseline
      ? meetings.filter((meeting) => !this.meetingCoveredByAnalysis(meeting, baseline))
      : meetings;
    if (baseline && !inputMeetings.length) {
      throw new Error("기존 분석 이후 새로 추가된 회의록이 없습니다. 전체 재분석이 필요하면 기존 분석 자료 활용 옵션을 해제해 주세요.");
    }
    const withContent = await Promise.all(inputMeetings.map(async (meeting) => ({
      ...meeting,
      content: meeting.file instanceof TFile ? await this.app.vault.cachedRead(meeting.file) : ""
    })));
    const baselineWithContent = baseline ? {
      ...baseline,
      content: baseline.file instanceof TFile ? await this.app.vault.cachedRead(baseline.file) : ""
    } : null;
    return buildMeetingAnalysisPrompt({
      ticketId: normalized,
      meetings: withContent,
      ticketPath: rootFile?.path || "",
      outputFolder: this.ticketMeetingsFolder(normalized),
      baseline: baselineWithContent
    });
  }

  async deleteTicketMeeting(meeting) {
    if (!(meeting?.file instanceof TFile)) throw new Error("삭제할 회의록 노트를 찾을 수 없습니다.");
    const folder = `${meeting.ticketId ? this.ticketMeetingsFolder(meeting.ticketId) : this.generalMeetingsFolder()}/`;
    if (!meeting.file.path.startsWith(folder)) throw new Error("티켓 회의록 폴더 밖의 파일은 삭제할 수 없습니다.");
    if (meeting.sourcePdf) {
      const pdf = this.app.vault.getAbstractFileByPath(normalizePath(meeting.sourcePdf));
      if (pdf instanceof TFile && pdf.path.startsWith(folder)) await this.app.vault.trash(pdf, true);
    }
    await this.app.vault.trash(meeting.file, true);
    new Notice("회의록을 휴지통으로 이동했습니다.");
  }

  confirmDeleteMeetingPath(path, onDeleted = null) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) return new Notice("삭제할 회의록을 찾을 수 없습니다.");
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const meeting = {
      file,
      ticketId: normalizeTicketId(frontmatter.ticket || ""),
      title: file.basename,
      sourcePdf: parseWikiLink(frontmatter.source_pdf || "")
    };
    new ConfirmActionModal(
      this.app,
      "회의록 삭제",
      `'${meeting.title}'을 Obsidian에서 삭제하시겠습니까?`,
      async () => {
        await this.deleteTicketMeeting(meeting);
        if (typeof onDeleted === "function") await onDeleted();
      },
      "삭제",
      "회의록 삭제"
    ).open();
  }

  async importMeetingFiles(ticketId, files, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (normalized && !(rootFile instanceof TFile)) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);
    const selected = [...(files || [])];
    const textFiles = selected.filter((file) => /\.(?:md|txt)$/i.test(file.name));
    const pdfFiles = selected.filter((file) => /\.pdf$/i.test(file.name));
    if (textFiles.length !== 1) throw new Error("Markdown(.md) 또는 텍스트(.txt) 파일을 정확히 1개 선택해 주세요.");
    if (pdfFiles.length > 1) throw new Error("PDF 원본은 1개만 함께 선택할 수 있습니다.");
    const source = textFiles[0];
    const sourceText = await source.text();
    if (!sourceText.trim()) throw new Error("선택한 회의록 파일이 비어 있습니다.");
    const folder = normalized ? this.ticketMeetingsFolder(normalized) : this.generalMeetingsFolder();
    await this.ensureFolder(folder);
    const meetingDate = options.meetingDate || parseMeetingDate(`${source.name}\n${sourceText}`);
    const titleFromBody = sourceText.match(/^##\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$/m)?.[1] || source.name;
    const title = cleanMeetingTitle(options.title || titleFromBody, normalized);
    const fileStem = `${meetingDate.slice(0, 10)} ${meetingDate.slice(11, 16).replace(":", "-")} - ${safeFileName(title).slice(0, 90)}`;
    let pdfPath = "";
    if (pdfFiles[0]) {
      pdfPath = await this.uniqueVaultPath(`${folder}/${fileStem} - 원본.pdf`);
      await this.app.vault.createBinary(pdfPath, await pdfFiles[0].arrayBuffer());
    }
    const notePath = await this.uniqueVaultPath(`${folder}/${fileStem}.md`);
    const markdown = buildMeetingNoteMarkdown({
      ticketId: normalized,
      sourceName: source.name,
      sourceText,
      meetingDate,
      title,
      pdfPath
    });
    const note = await this.app.vault.create(notePath, markdown);
    if (rootFile instanceof TFile) await this.ensureMeetingSection(rootFile, normalized);
    return note;
  }

  async uniqueVaultPath(path) {
    const normalized = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(normalized)) return normalized;
    const extension = normalized.match(/(\.[^./]+)$/)?.[1] || "";
    const base = extension ? normalized.slice(0, -extension.length) : normalized;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(`${base} (${suffix})${extension}`)) suffix += 1;
    return normalizePath(`${base} (${suffix})${extension}`);
  }

  async ensureMeetingSection(file, ticketId) {
    await this.app.vault.process(file, (markdown) =>
      ensureSectionActionBlock(markdown, ticketId, "🗓️ 회의록", "clt-ticket-meeting-actions")
    );
  }

  renderTicketSectionAction(el, file, ticketId, type) {
    el.addClass("clt-ticket-heading-action");
    el.addClass(type === "worklog" ? "clt-ticket-worklog-action" : "clt-ticket-todo-action");
    el.closest(".markdown-preview-view, .markdown-rendered")?.classList.add("clt-ticket-note-render");
    const button = el.createEl("button", {
      cls: "clt-ticket-section-add",
      text: type === "worklog" ? "＋ 새 작업 추가" : "＋ 할 일 추가"
    });
    button.addEventListener("click", () => {
      if (type === "worklog") this.openTicketWorkLogEntry(file, ticketId);
      else this.openTicketTodoEntry(file, ticketId);
    });
    const moveButtonBesideHeading = () => {
      let cursor = el;
      let heading = null;
      while (cursor && !heading) {
        let sibling = cursor.previousElementSibling;
        while (sibling && !heading) {
          if (sibling.matches?.("h2")) heading = sibling;
          else heading = sibling.querySelector?.("h2:last-of-type") || null;
          sibling = sibling.previousElementSibling;
        }
        if (heading || cursor.matches?.(".markdown-preview-section, .markdown-rendered")) break;
        cursor = cursor.parentElement;
      }
      if (!heading) return;
      heading.addClass("clt-ticket-section-heading");
      heading.appendChild(button);
      el.addClass("clt-ticket-heading-action-mounted");
    };
    moveButtonBesideHeading();
    window.requestAnimationFrame(moveButtonBesideHeading);
  }

  decorateTicketNote(el, ctx) {
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    const ticketId = this.rootTicketIdFromFile(file);
    if (!ticketId) return;
    el.addClass("clt-ticket-note-render");
    for (const heading of el.querySelectorAll("h2")) {
      const normalized = normalizedHeadingText(heading.textContent);
      const isWorkLog = normalized.includes("작업일지");
      const isTodo = normalized.includes("todo");
      if (!isWorkLog && !isTodo) continue;
      heading.addClass("clt-ticket-section-heading");
      if (!heading.querySelector(".clt-ticket-section-add")) {
        const button = heading.createEl("button", {
          cls: "clt-ticket-section-add",
          text: isWorkLog ? "＋ 새 작업 추가" : "＋ 할 일 추가"
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isWorkLog) this.openTicketWorkLogEntry(file, ticketId);
          else this.openTicketTodoEntry(file, ticketId);
        });
      }
      if (isTodo) {
        let sibling = heading.nextElementSibling;
        while (sibling && !/^H[1-2]$/.test(sibling.tagName)) {
          if (sibling.matches("ul.contains-task-list, ul.task-list")) sibling.addClass("clt-ticket-todo-list");
          sibling = sibling.nextElementSibling;
        }
      }
    }
  }

  renderTicketTodoBoard(sourceList, ticketId, tasks) {
    if (!(sourceList instanceof HTMLElement)) return;
    const existing = sourceList.previousElementSibling;
    if (existing?.matches?.(".clt-ticket-mini-todo-board")) existing.remove();
    sourceList.addClass("clt-ticket-todo-source-hidden");

    const board = document.createElement("div");
    board.className = "clt-ticket-mini-todo-board";
    const definitions = [
      ["pending", "진행 전", "○"],
      ["in-progress", "진행 중", "◐"],
      ["done", "완료", "✓"]
    ];
    for (const [status, label, icon] of definitions) {
      const column = board.createDiv({ cls: `clt-ticket-mini-column is-${status}` });
      const heading = column.createDiv({ cls: "clt-ticket-mini-column-heading" });
      heading.createSpan({ cls: "clt-ticket-mini-status-icon", text: icon });
      heading.createSpan({ text: label });
      const columnTasks = tasks.filter((task) => task.status === status);
      heading.createSpan({ cls: "clt-ticket-mini-count", text: String(columnTasks.length) });
      const body = column.createDiv({ cls: "clt-ticket-mini-column-body" });
      column.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        column.addClass("drag-over");
      });
      column.addEventListener("dragleave", (event) => {
        if (!column.contains(event.relatedTarget)) column.removeClass("drag-over");
      });
      column.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        column.removeClass("drag-over");
        const taskId = event.dataTransfer?.getData("text/plain") || "";
        const task = tasks.find((item) => item.id === taskId);
        if (!task || task.status === status) return;
        column.addClass("is-updating");
        try {
          await this.updateTodoTaskDetails(task, { status });
          const refreshed = await this.readTodoTasks(ticketId);
          this.renderTicketTodoBoard(sourceList, ticketId, refreshed);
          new Notice(`${ticketId} To-Do를 '${label}' 상태로 변경했습니다.`);
        } catch (error) {
          column.removeClass("is-updating");
          new Notice(`To-Do 상태 변경 실패: ${error.message || error}`, 9000);
        }
      });
      if (!columnTasks.length) {
        body.createDiv({ cls: "clt-ticket-mini-empty", text: "할 일 없음" });
      } else for (const task of columnTasks) {
        const card = body.createEl("button", {
          cls: "clt-ticket-mini-card",
          attr: { type: "button", title: "클릭하여 수정하거나 다른 상태로 드래그", draggable: "true" }
        });
        const visualTone = todoVisualTone(task);
        if (visualTone) card.addClass(visualTone);
        card.dataset.todoId = task.id;
        card.createDiv({ cls: "clt-ticket-mini-card-text", text: task.text || "(내용 없음)" });
        if (task.details) {
          const detail = card.createDiv({ cls: "clt-ticket-mini-card-detail markdown-rendered" });
          void this.renderMarkdownInto(detail, task.details, task.filePath || "");
        }
        const meta = card.createDiv({ cls: "clt-ticket-mini-card-meta" });
        meta.createSpan({ cls: "clt-ticket-mini-card-due", text: task.dueDate ? `완료 예정 ${task.dueDate}` : "완료 예정일 없음" });
        meta.createSpan({ cls: "clt-ticket-mini-card-action", text: "열기 ›" });
        card.addEventListener("dragstart", (event) => {
          card.dataset.dragged = "true";
          card.addClass("dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", task.id);
          }
        });
        card.addEventListener("dragend", () => {
          card.removeClass("dragging");
          window.setTimeout(() => { delete card.dataset.dragged; }, 0);
        });
        card.addEventListener("click", (event) => {
          if (card.dataset.dragged === "true") return;
          event.preventDefault();
          event.stopPropagation();
          this.openTodoDetailEntryModal(task, async () => {
            const refreshed = await this.readTodoTasks(ticketId);
            this.renderTicketTodoBoard(sourceList, ticketId, refreshed);
          });
        });
      }
      const quickAdd = column.createEl("button", {
        cls: "clt-ticket-mini-add",
        text: "＋ To-Do 추가",
        attr: { type: "button", title: `${label} 상태로 새 To-Do 추가` }
      });
      quickAdd.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openTodoEntryModal(ticketId, async () => {
          const refreshed = await this.readTodoTasks(ticketId);
          this.renderTicketTodoBoard(sourceList, ticketId, refreshed);
        }, status);
      });
    }
    sourceList.parentElement?.insertBefore(board, sourceList);
  }

  renderTicketWorkLogCards(sourceList, ticketId, workLogs, sourcePath = "") {
    if (!(sourceList instanceof HTMLElement)) return;
    const existing = sourceList.previousElementSibling;
    if (existing?.matches?.(".clt-ticket-worklog-cards")) existing.remove();
    sourceList.addClass("clt-ticket-worklog-source-hidden");
    const viewMode = sourceList.dataset.cltWorklogView || "latest";
    const sortDirection = sourceList.dataset.cltWorklogSort || "desc";
    const sortedLogs = [...workLogs].sort((left, right) => {
      const compared = String(left.dateTime).localeCompare(String(right.dateTime));
      return sortDirection === "asc" ? compared : -compared;
    });
    const visibleLogs = viewMode === "latest" ? sortedLogs.slice(0, 1) : sortedLogs;
    const container = document.createElement("div");
    container.className = "clt-ticket-worklog-cards";
    const toolbar = document.createElement("div");
    toolbar.className = "clt-ticket-worklog-toolbar";
    const viewButtons = document.createElement("div");
    viewButtons.className = "clt-ticket-worklog-view-buttons";
    const latestButton = document.createElement("button");
    latestButton.type = "button";
    latestButton.className = `clt-ticket-worklog-button${viewMode === "latest" ? " is-active" : ""}`;
    latestButton.textContent = "최근 작업";
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = `clt-ticket-worklog-button${viewMode === "all" ? " is-active" : ""}`;
    allButton.textContent = "전체 작업";
    const sortButton = document.createElement("button");
    sortButton.type = "button";
    sortButton.className = `clt-ticket-worklog-button clt-ticket-worklog-sort${viewMode === "all" ? "" : " is-hidden"}`;
    sortButton.textContent = sortDirection === "desc" ? "최신순" : "오래된순";
    sortButton.title = "전체 작업 정렬 순서 변경";
    latestButton.addEventListener("click", () => {
      sourceList.dataset.cltWorklogView = "latest";
      this.renderTicketWorkLogCards(sourceList, ticketId, workLogs, sourcePath);
    });
    allButton.addEventListener("click", () => {
      sourceList.dataset.cltWorklogView = "all";
      this.renderTicketWorkLogCards(sourceList, ticketId, workLogs, sourcePath);
    });
    sortButton.addEventListener("click", () => {
      sourceList.dataset.cltWorklogSort = sortDirection === "desc" ? "asc" : "desc";
      this.renderTicketWorkLogCards(sourceList, ticketId, workLogs, sourcePath);
    });
    viewButtons.append(latestButton, allButton);
    toolbar.append(viewButtons, sortButton);
    container.appendChild(toolbar);
    for (const entry of visibleLogs) {
      const card = container.createDiv({ cls: "clt-ticket-worklog-card" });
      const heading = card.createDiv({ cls: "clt-ticket-worklog-heading" });
      heading.createDiv({ cls: "clt-ticket-worklog-time", text: entry.dateTime || "날짜 없음" });
      const remove = heading.createEl("button", {
        cls: "clt-ticket-worklog-delete",
        text: "×",
        attr: { type: "button", title: "작업 일지 삭제", "aria-label": "작업 일지 삭제" }
      });
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        new ConfirmActionModal(
          this.app,
          "작업 일지 삭제",
          `${entry.dateTime || "선택한"} 작업 일지를 삭제하시겠습니까?`,
          async () => {
            await this.deleteTicketWorkLog(sourcePath, entry);
            const file = this.app.vault.getAbstractFileByPath(sourcePath);
            const refreshed = file instanceof TFile ? extractTicketWorkLogs(await this.app.vault.cachedRead(file)) : [];
            this.renderTicketWorkLogCards(sourceList, ticketId, refreshed, sourcePath);
          },
          "삭제"
        ).open();
      });
      const body = card.createDiv({ cls: "clt-ticket-worklog-body markdown-rendered" });
      if (entry.contentMarkdown) void this.renderMarkdownInto(body, entry.contentMarkdown, sourcePath);
      else body.createSpan({ cls: "clt-ticket-worklog-empty", text: "내용 없음" });
    }
    sourceList.parentElement?.insertBefore(container, sourceList);
  }

  async deleteTicketWorkLog(sourcePath, entry) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(String(sourcePath || "")));
    if (!(file instanceof TFile)) throw new Error("원본 티켓 노트를 찾을 수 없습니다.");
    let deleted = false;
    await this.app.vault.process(file, (markdown) => {
      const logs = extractTicketWorkLogs(markdown);
      const target = logs.find((item) =>
        item.dateTime === entry?.dateTime
        && item.contentMarkdown === entry?.contentMarkdown
      );
      if (!target || !Number.isInteger(target.startLine)) return markdown;
      const lines = markdown.split(/\r?\n/);
      lines.splice(target.startLine, Math.max(1, target.endLine - target.startLine));
      deleted = true;
      return lines.join(markdown.includes("\r\n") ? "\r\n" : "\n");
    });
    if (!deleted) throw new Error("삭제할 작업 일지를 찾을 수 없습니다.");
    new Notice("작업 일지를 삭제했습니다.");
    return true;
  }

  openTicketWorkLogEntry(file, ticketId) {
    new TimedEntryModal(this.app, {
      title: `${ticketId} 새 작업 일지`,
      placeholder: "새 작업 내용을 입력하세요.",
      emptyMessage: "작업 내용을 입력해 주세요.",
      sourcePath: file.path,
      onSubmit: async (content) => {
        const time = localIsoDateTime().slice(0, 16);
        await this.app.vault.process(file, (markdown) => appendEntryToMarkdownSection(
          markdown,
          "📝 작업 일지",
          formatMarkdownListEntry(`- ${time} : `, content)
        ));
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter["마지막확인"] = time.slice(0, 10);
        });
        new Notice("작업 일지가 추가되었습니다.");
      }
    }).open();
  }

  openTicketTodoEntry(file, ticketId) {
    this.openTodoEntryModal(ticketId);
  }

  createRichMarkdownInput(parent, initialValue = "", sourcePath = "", placeholder = "") {
    return createRichMarkdownEditor(this.app, this, parent, initialValue, sourcePath, placeholder);
  }

  async renderMarkdownInto(container, markdown, sourcePath = "") {
    if (typeof container.empty === "function") container.empty();
    else container.innerHTML = "";
    await MarkdownRenderer.render(this.app, String(markdown || ""), container, sourcePath, this);
  }

  openTodoEntryModal(preselectedTicketId = "", onSaved = null, preselectedStatus = "pending") {
    new TodoEntryModal(this.app, this, preselectedTicketId, onSaved, preselectedStatus).open();
  }

  openTodoDetailEntryModal(task, onSaved = null) {
    new TodoDetailEntryModal(this.app, this, task, onSaved).open();
  }

  async handleLivePreviewTodoClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const taskLine = target?.closest?.(".markdown-source-view.mod-cm6 .HyperMD-task-line");
    if (!taskLine || target.closest("input[type='checkbox'], a, button")) return;
    const selection = window.getSelection();
    if (selection?.toString() && taskLine.contains(selection.anchorNode)) return;

    const leaf = this.app.workspace.getLeavesOfType("markdown")
      .find((item) => item.containerEl?.contains(taskLine));
    const file = leaf?.view?.file;
    const ticketId = this.rootTicketIdFromFile(file);
    if (!ticketId) return;

    const tasks = await this.readTodoTasks(ticketId);
    if (!tasks.length) return;
    const mousePosition = leaf?.view?.editor?.posAtMouse?.(event);
    let task = mousePosition
      ? tasks.find((item) => item.lineIndex === mousePosition.line)
      : null;
    if (!task) {
      const rendered = String(taskLine.textContent || "").replace(/\s+/g, " ").trim();
      const dateTime = rendered.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/)?.[0] || "";
      const candidates = tasks.filter((item) => item.dateTime === dateTime);
      task = candidates.find((item) => rendered.includes(item.text)) || candidates[0];
    }
    if (!task) return;

    event.preventDefault();
    event.stopPropagation();
    this.openTodoDetailEntryModal(task);
  }

  async readTodoTasks(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) return [];
    const markdown = await this.app.vault.read(file);
    const lines = markdown.split(/\r?\n/);
    let sectionStart = -1;
    let headingLevel = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const heading = matchTodoHeading(lines[index]);
      if (!heading) continue;
      sectionStart = index + 1;
      headingLevel = heading[1].length;
      break;
    }
    if (sectionStart < 0) return [];

    const tasks = [];
    let taskIndex = 0;
    for (let lineIndex = sectionStart; lineIndex < lines.length; lineIndex += 1) {
      const heading = lines[lineIndex].match(/^(#{1,6})\s+/);
      if (heading && heading[1].length <= headingLevel) break;
      const checkbox = lines[lineIndex].match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (!checkbox) continue;
      const rawContent = checkbox[2];
      const dateTime = rawContent.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*:\s*/)?.[1] || "";
      const dueDate = rawContent.match(/<!--\s*clt-todo-due:(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)\s*-->/i)?.[1] || "";
      const completedAt = rawContent.match(/<!--\s*clt-todo-completed:([^>]+?)\s*-->/i)?.[1]?.trim() || "";
      const details = decodeTodoDetail(rawContent.match(/<!--\s*clt-todo-detail:([^>]*)\s*-->/i)?.[1]?.trim() || "");
      const inProgress = /<!--\s*clt-todo:in-progress\s*-->/i.test(rawContent);
      const text = stripCltTodoMetadata(rawContent)
        .replace(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*:\s*/, "")
        .trim();
      const done = checkbox[1].toLowerCase() === "x";
      tasks.push({
        id: `${file.path}::${taskIndex}`,
        filePath: file.path,
        ticketId: normalized,
        taskIndex,
        lineIndex,
        dateTime,
        dueDate,
        completedAt,
        details,
        text,
        rawContent,
        status: done ? "done" : inProgress ? "in-progress" : "pending"
      });
      taskIndex += 1;
    }
    return tasks;
  }

  generalTodoFile() {
    const root = this.rootFolder();
    return this.app.vault.getAbstractFileByPath(`${root}/To-Do.md`)
      || this.app.vault.getAbstractFileByPath(`${root}/일반 To-Do.md`)
      || null;
  }

  async ensureGeneralTodoFile() {
    const existing = this.generalTodoFile();
    if (existing instanceof TFile) return existing;
    const root = this.rootFolder();
    await this.ensureFolder(root);
    const path = `${root}/To-Do.md`;
    const initialContent = `# 📋 일반 To-Do\n\n## ✅ To-Do\n\n`;
    return await this.app.vault.create(path, initialContent);
  }

  async updateTodoTaskDetails(task, changes = {}) {
    const normalized = normalizeTicketId(task?.ticketId);
    const file = task?.filePath
      ? this.app.vault.getAbstractFileByPath(task.filePath)
      : (normalized ? this.rootTicketFile(normalized) : this.generalTodoFile());
    if (!(file instanceof TFile)) throw new Error(normalized ? `${normalized} 티켓 노트를 찾을 수 없습니다.` : "To-Do 노트를 찾을 수 없습니다.");
    const cleanText = stripCltTodoMetadata(
      String(changes.text ?? task.text ?? "").replace(/\r?\n+/g, " ")
    );
    if (!cleanText) throw new Error("할 일을 입력해 주세요.");
    const status = ["pending", "in-progress", "done"].includes(changes.status)
      ? changes.status
      : task.status;
    const dueDate = String(changes.dueDate ?? task.dueDate ?? "").trim();
    const details = String(changes.details ?? task.details ?? "").trim();
    const completedAt = status === "done"
      ? (task.completedAt || localIsoDateTime().slice(0, 16))
      : "";
    const dateTime = task.dateTime || localIsoDateTime().slice(0, 16);
    const checkbox = status === "done" ? "x" : " ";
    const statusMarker = status === "in-progress" ? " <!-- clt-todo:in-progress -->" : "";
    const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
    const completedMarker = completedAt ? ` <!-- clt-todo-completed:${completedAt} -->` : "";
    const detailMarker = details ? ` <!-- clt-todo-detail:${encodeTodoDetail(details)} -->` : "";
    const replacement = `- [${checkbox}] ${dateTime} : ${cleanText}${statusMarker}${dueMarker}${completedMarker}${detailMarker}`;
    let replaced = false;
    await this.app.vault.process(file, (markdown) => {
      const lines = markdown.split(/\r?\n/);
      let sectionStart = -1;
      let headingLevel = 0;
      let currentTaskIndex = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const heading = matchTodoHeading(lines[index]);
        if (!heading) continue;
        sectionStart = index + 1;
        headingLevel = heading[1].length;
        break;
      }
      if (sectionStart < 0) throw new Error("To-Do 섹션을 찾을 수 없습니다.");
      for (let index = sectionStart; index < lines.length; index += 1) {
        const heading = lines[index].match(/^(#{1,6})\s+/);
        if (heading && heading[1].length <= headingLevel) break;
        if (!/^\s*-\s*\[[ xX]\]\s*/.test(lines[index])) continue;
        if (currentTaskIndex === Number(task.taskIndex)) {
          lines[index] = replacement;
          replaced = true;
          break;
        }
        currentTaskIndex += 1;
      }
      if (!replaced) throw new Error("수정할 To-Do 항목을 찾을 수 없습니다.");
      return lines.join(markdown.includes("\r\n") ? "\r\n" : "\n");
    });
    await this.touchTodoLastChecked(file);
    return {
      ...task,
      ticketId: normalized,
      filePath: file.path,
      text: cleanText,
      status,
      dueDate,
      details,
      completedAt,
      dateTime,
      rawContent: replacement.replace(/^\s*-\s*\[[ xX]\]\s*/, "")
    };
  }

  async deleteTodoTask(task) {
    const normalized = normalizeTicketId(task?.ticketId);
    const file = task?.filePath
      ? this.app.vault.getAbstractFileByPath(task.filePath)
      : (normalized ? this.rootTicketFile(normalized) : this.generalTodoFile());
    if (!(file instanceof TFile)) throw new Error(normalized ? `${normalized} 티켓 노트를 찾을 수 없습니다.` : "To-Do 노트를 찾을 수 없습니다.");
    let deleted = false;
    await this.app.vault.process(file, (markdown) => {
      const lines = markdown.split(/\r?\n/);
      let sectionStart = -1;
      let headingLevel = 0;
      let currentTaskIndex = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const heading = matchTodoHeading(lines[index]);
        if (!heading) continue;
        sectionStart = index + 1;
        headingLevel = heading[1].length;
        break;
      }
      if (sectionStart < 0) throw new Error("To-Do 섹션을 찾을 수 없습니다.");
      for (let index = sectionStart; index < lines.length; index += 1) {
        const heading = lines[index].match(/^(#{1,6})\s+/);
        if (heading && heading[1].length <= headingLevel) break;
        if (!/^\s*-\s*\[[ xX]\]\s*/.test(lines[index])) continue;
        if (currentTaskIndex === Number(task.taskIndex)) {
          lines.splice(index, 1);
          deleted = true;
          break;
        }
        currentTaskIndex += 1;
      }
      if (!deleted) throw new Error("삭제할 To-Do 항목을 찾을 수 없습니다. 화면을 새로고침한 후 다시 시도해 주세요.");
      return lines.join(markdown.includes("\r\n") ? "\r\n" : "\n");
    });
    await this.touchTodoLastChecked(file);
  }

  async touchTodoLastChecked(file) {
    if (!(file instanceof TFile)) return "";
    const today = localIsoDateTime().slice(0, 10);
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter["마지막확인"] = today;
      });
    } catch (_) {}
    return today;
  }

  async addTodoToGeneral(content, dueDate = "", status = "pending", details = "") {
    const file = await this.ensureGeneralTodoFile();
    const cleanContent = stripCltTodoMetadata(String(content || "").replace(/\r?\n+/g, " "));
    if (!cleanContent) throw new Error("할 일을 입력해 주세요.");
    const safeStatus = ["pending", "in-progress", "done"].includes(status) ? status : "pending";
    const time = localIsoDateTime().slice(0, 16);
    const checkbox = safeStatus === "done" ? "x" : " ";
    const statusMarker = safeStatus === "in-progress" ? " <!-- clt-todo:in-progress -->" : "";
    const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
    const completedMarker = safeStatus === "done" ? ` <!-- clt-todo-completed:${time} -->` : "";
    const detailMarker = String(details || "").trim() ? ` <!-- clt-todo-detail:${encodeTodoDetail(details)} -->` : "";
    await this.app.vault.process(file, (markdown) => appendEntryToMarkdownSection(
      markdown,
      "✅ To-Do",
      `- [${checkbox}] ${time} : ${cleanContent}${statusMarker}${dueMarker}${completedMarker}${detailMarker}`
    ));
    return { ticketId: "", time, path: file.path };
  }

  async addTodoToTicket(ticketId, content, dueDate = "", status = "pending", details = "") {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) return this.addTodoToGeneral(content, dueDate, status, details);
    const file = this.rootTicketFile(normalized);
    if (!(file instanceof TFile)) throw new Error(`${normalized} 티켓 노트를 찾을 수 없습니다.`);
    const cleanContent = stripCltTodoMetadata(String(content || "").replace(/\r?\n+/g, " "));
    if (!cleanContent) throw new Error("할 일을 입력해 주세요.");
    const safeStatus = ["pending", "in-progress", "done"].includes(status) ? status : "pending";
    const time = localIsoDateTime().slice(0, 16);
    const checkbox = safeStatus === "done" ? "x" : " ";
    const statusMarker = safeStatus === "in-progress" ? " <!-- clt-todo:in-progress -->" : "";
    const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
    const completedMarker = safeStatus === "done" ? ` <!-- clt-todo-completed:${time} -->` : "";
    const detailMarker = String(details || "").trim() ? ` <!-- clt-todo-detail:${encodeTodoDetail(details)} -->` : "";
    await this.app.vault.process(file, (markdown) => appendEntryToMarkdownSection(
      markdown,
      "✅ To-Do",
      `- [${checkbox}] ${time} : ${cleanContent}${statusMarker}${dueMarker}${completedMarker}${detailMarker}`
    ));
    await this.touchTodoLastChecked(file);
    return { ticketId: normalized, time, path: file.path };
  }

  async normalizeTodoMetadataOnce() {
    if ((this.data.todoMetadataVersion || 0) >= 2) return;
    for (const file of this.rootTicketFiles()) {
      await this.app.vault.process(file, (markdown) => {
        const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
        const lines = markdown.split(/\r?\n/);
        let inTodoSection = false;
        let todoHeadingLevel = 0;
        for (let index = 0; index < lines.length; index += 1) {
          const heading = lines[index].match(/^(#{1,6})\s+(.*)$/);
          if (heading) {
            const normalized = String(heading[2] || "").replace(/[^a-z0-9가-힣]/gi, "").toLowerCase();
            if (normalized.includes("todo")) {
              const cleanedHeading = String(heading[2] || "").replace(/\s*[\]\)}]+\s*$/, "").trim();
              if (cleanedHeading !== heading[2]) lines[index] = `${heading[1]} ${cleanedHeading}`;
              inTodoSection = true;
              todoHeadingLevel = heading[1].length;
              continue;
            }
            if (inTodoSection && heading[1].length <= todoHeadingLevel) inTodoSection = false;
          }
          if (!inTodoSection) continue;
          const task = lines[index].match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/);
          if (!task) continue;
          const raw = task[4];
          const dueDate = raw.match(/<!--\s*clt-todo-due:(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)\s*-->/i)?.[1] || "";
          const completedAt = raw.match(/<!--\s*clt-todo-completed:([^>]+?)\s*-->/i)?.[1]?.trim() || "";
          const inProgress = /<!--\s*clt-todo:in-progress\s*-->/i.test(raw);
          const clean = stripCltTodoMetadata(raw);
          const statusMarker = task[2].toLowerCase() !== "x" && inProgress ? " <!-- clt-todo:in-progress -->" : "";
          const dueMarker = dueDate ? ` <!-- clt-todo-due:${dueDate} -->` : "";
          const completedMarker = task[2].toLowerCase() === "x" && completedAt
            ? ` <!-- clt-todo-completed:${completedAt} -->`
            : "";
          lines[index] = `${task[1]}${task[2]}${task[3]}${clean}${statusMarker}${dueMarker}${completedMarker}`;
        }
        return lines.join(newline);
      });
    }
    this.data.todoMetadataVersion = 2;
    await this.savePluginData();
  }

  async ensureStatusBlocksForAllRootTickets() {
    for (const file of this.rootTicketFiles()) {
      const ticketId = this.rootTicketIdFromFile(file);
      await this.app.vault.process(file, (markdown) => {
        let next = markdown;
        if (!/```clt-ticket-status\b/.test(next)) {
          const block = `\n\`\`\`clt-ticket-status\nticket: ${ticketId}\n\`\`\`\n`;
          const frontmatter = next.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
          next = frontmatter
            ? `${frontmatter[0]}${block}\n${next.slice(frontmatter[0].length)}`
            : `${block}\n${next}`;
        }
        next = next.replace(/(^##[^\r\n]*To-Do[^\r\n]*\r?\n(?:\r?\n)*)(?:- \[ \][ \t]*(?:\r?\n|$))/mi, "$1");
        next = ensureSectionActionBlock(next, ticketId, "📝 작업 일지", "clt-ticket-worklog-actions");
        next = ensureSectionActionBlock(next, ticketId, "🗓️ 회의록", "clt-ticket-meeting-actions");
        return ensureSectionActionBlock(next, ticketId, "✅ To-Do", "clt-ticket-todo-actions");
      });
    }
  }

  statusGuideFile(category) {
    const normalized = String(category || "").toUpperCase();
    const fileName = `${normalized} 상태별 업무 가이드.md`;
    return this.app.vault.getMarkdownFiles().find((file) =>
      file.name === fileName && file.path.split("/").includes(normalized)
    ) || null;
  }

  async openStatusGuideNote(category) {
    const file = this.statusGuideFile(category);
    if (!(file instanceof TFile)) {
      return new Notice(`${String(category || "").toUpperCase()} 전체 업무 가이드 노트를 찾을 수 없습니다. 현재 상태 가이드는 팝업에 내장되어 있습니다.`, 7000);
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  openCurrentStatusGuide(ticketId) {
    const normalized = normalizeTicketId(ticketId);
    const file = this.rootTicketFile(normalized);
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
    const category = String(frontmatter.category || normalized.slice(0, 2)).toUpperCase();
    const status = String(frontmatter.status || this.data.tickets[normalized]?.state || "").trim();
    const guideMap = this.organizationPack?.statusGuides?.[category] || STATUS_GUIDES[category] || {};
    const guideKey = Object.keys(guideMap).find((key) => key.toLowerCase() === status.toLowerCase());
    new StatusGuideModal(this.app, this, normalized, category, status, guideKey ? guideMap[guideKey] : null).open();
  }

  renderTicketStatusControl(el, ticketId) {
    el.addClass("clt-sn-ticket-status");
    const ticket = this.data.tickets[ticketId];
    if (ticket?.shortDescription || ticket?.description) {
      const summary = el.createDiv({ cls: "clt-ticket-summary" });
      if (ticket.shortDescription) {
        summary.createDiv({ cls: "clt-sn-summary-label", text: "Short Description" });
        summary.createDiv({ cls: "clt-ticket-summary-title", text: ticket.shortDescription });
      }
      if (ticket.description) {
        const originalDescription = summary.createEl("details", { cls: "clt-ticket-summary-details" });
        originalDescription.createEl("summary", { text: "Description 펼치기" });
        originalDescription.createEl("pre", { text: ticket.description });
      }
      const languages = new Set([
        ...Object.keys(ticket.translations?.shortDescription || {}),
        ...Object.keys(ticket.translations?.description || {})
      ]);
      for (const language of languages) {
        const translatedShort = ticket.translations?.shortDescription?.[language] || "";
        const translatedDescription = ticket.translations?.description?.[language] || "";
        if (!translatedShort && !translatedDescription) continue;
        const languageLabel = language === "ko" ? "한국어" : language === "vi" ? "베트남어" : language;
        const translation = summary.createEl("details", { cls: "clt-ticket-translation-details" });
        translation.createEl("summary", { text: `${languageLabel} 번역 펼치기` });
        if (translatedShort) {
          translation.createDiv({ cls: "clt-sn-summary-label", text: "Short Description" });
          translation.createDiv({ cls: "clt-ticket-summary-title clt-sn-translation", text: translatedShort });
        }
        if (translatedDescription) {
          translation.createDiv({ cls: "clt-sn-summary-label", text: "Description" });
          translation.createEl("pre", { cls: "clt-sn-translation", text: translatedDescription });
        }
      }
    }

    const controls = el.createDiv({ cls: "clt-ticket-status-controls" });
    const status = controls.createSpan({ cls: "clt-sn-ticket-status-value" });
    const readStatus = () => {
      const file = this.rootTicketFile(ticketId);
      const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter || {} : {};
      status.setText(`ServiceNow 상태: ${String(fm.status || "미확인")}`);
    };
    readStatus();
    const guideButton = controls.createEl("button", {
      text: "현재 상태 업무 가이드",
      cls: "clt-status-guide-button"
    });
    guideButton.hidden = !this.organizationFeatureEnabled("statusGuides");
    guideButton.addEventListener("click", () => this.openCurrentStatusGuide(ticketId));
    const aiPrompt = controls.createEl("button", { text: "AI 티켓 분석 프롬프트 생성" });
    aiPrompt.hidden = !this.organizationFeatureEnabled("aiPrompt");
    const meetingAnalysis = controls.createEl("button", { text: "AI 회의록 분석" });
    meetingAnalysis.addEventListener("click", () => this.openMeetingAnalysisPromptModal(ticketId));
    const button = controls.createEl("button", { text: "상태·기본정보 갱신" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.setText("갱신 중…");
      try {
        const result = await this.syncTicketStatus(ticketId, { notify: true });
        if (result?.state) status.setText(`ServiceNow 상태: ${result.state}`);
        else readStatus();
      } catch (_) {
        readStatus();
      } finally {
        button.disabled = false;
        button.setText("상태·기본정보 갱신");
      }
    });
    const meetingImport = controls.createEl("button", { text: "회의록 가져오기" });
    meetingImport.addEventListener("click", () => this.openDriveMeetingCandidateModal(ticketId));
    const documents = controls.createEl("button", { text: "BS·FS·DS·UT 문서 갱신" });
    documents.hidden = !this.documentAutomationEnabled();
    documents.addEventListener("click", async () => {
      documents.disabled = true;
      documents.setText("문서 검색 중…");
      try {
        await this.refreshTicketDocuments(ticketId, { notify: true });
      } catch (error) {
        new Notice(`${ticketId} 문서 갱신 실패: ${error.message || error}`, 9000);
      } finally {
        documents.disabled = false;
        documents.setText("BS·FS·DS·UT 문서 갱신");
      }
    });
    const aiPromptDetails = el.createEl("details", { cls: "clt-ai-prompt-details" });
    aiPromptDetails.hidden = true;
    aiPromptDetails.createEl("summary", { text: "AI 티켓 분석 프롬프트 펼치기" });
    const aiPromptToolbar = aiPromptDetails.createDiv({ cls: "clt-ai-prompt-toolbar" });
    const copyPrompt = aiPromptToolbar.createEl("button", { text: "프롬프트 복사" });
    const aiPromptContent = aiPromptDetails.createEl("pre", { cls: "clt-ai-prompt-content" });
    let currentPrompt = "";
    copyPrompt.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!currentPrompt) return;
      try {
        await navigator.clipboard.writeText(currentPrompt);
        new Notice(`${ticketId} AI 티켓 분석 프롬프트를 클립보드에 복사했습니다.`, 5000);
      } catch (error) {
        new Notice(`AI 프롬프트 복사 실패: ${error.message || error}`, 8000);
      }
    });
    aiPrompt.addEventListener("click", async () => {
      aiPrompt.disabled = true;
      aiPrompt.setText("티켓 분석 프롬프트 생성 중…");
      try {
        const generated = await this.generateAiPromptForTicket(ticketId);
        if (generated?.prompt) {
          currentPrompt = generated.prompt;
          aiPromptContent.setText(currentPrompt);
          aiPromptDetails.hidden = false;
          aiPromptDetails.open = true;
          if (generated.messages.length) new Notice(generated.messages.join("\n"), 10000);
        }
      } catch (error) {
        console.error(`[ServiceNow Manage] ${ticketId} AI 티켓 분석 프롬프트 생성 실패`, error);
        new Notice(`AI 티켓 분석 프롬프트 생성 실패: ${error.message || error}`, 10000);
      } finally {
        aiPrompt.disabled = false;
        aiPrompt.setText("AI 티켓 분석 프롬프트 생성");
      }
    });
  }

  async generateAiPromptForTicket(ticketId) {
    if (!this.organizationFeatureEnabled("aiPrompt")) {
      return new Notice("설정에서 업무가이드팩을 등록하고 업무가이드 기능을 켜세요.", 7000);
    }
    const normalized = normalizeTicketId(ticketId);
    const category = normalized.slice(0, 2);
    const rootFile = this.rootTicketFile(normalized);
    if (!rootFile || !["CR", "SR"].includes(category)) {
      return new Notice("CR/SR 원본 티켓 노트를 찾을 수 없습니다.", 7000);
    }
    const templateFile = this.app.vault.getAbstractFileByPath(this.aiPromptTemplatePath());
    const source = templateFile instanceof TFile
      ? await this.app.vault.read(templateFile)
      : this.organizationPack?.promptTemplate || defaultAiPromptTemplate();
    let prompt = selectAiPromptTemplate(source, category);
    if (!prompt) {
      return new Notice(`AI 내용 노트에서 ${category}_TEMPLATE.md 구간을 찾을 수 없습니다.`, 7000);
    }

    const fm = this.app.metadataCache.getFileCache(rootFile)?.frontmatter || {};
    const messages = [];
    const previousTicket = this.data.tickets[normalized] || { ticketId: normalized, entries: [] };
    let ticket = previousTicket;
    try {
      const fresh = await this.fetchTicket(normalized);
      const oldById = new Map((previousTicket.entries || []).map((entry) => [entry.id, entry]));
      fresh.entries = (fresh.entries || []).map((entry) => ({
        ...entry,
        translations: oldById.get(entry.id)?.translations || entry.translations || {}
      }));
      fresh.translations = {};
      for (const field of ["shortDescription", "description"]) {
        if (fresh[field] === previousTicket[field] && previousTicket.translations?.[field]) {
          fresh.translations[field] = previousTicket.translations[field];
        }
      }
      fresh.documentSearchInitialized = Boolean(previousTicket.documentSearchInitialized);
      ticket = fresh;
      this.data.tickets[normalized] = fresh;
    } catch (error) {
      console.warn(`[ServiceNow Manage] ${normalized} AI 프롬프트용 최신 조회 실패`, error);
      messages.push(`ServiceNow 최신 조회에 실패하여 마지막 저장 데이터를 사용했습니다: ${error.message || error}`);
    }

    let documentSync = { local: {}, downloaded: [], warnings: [], failures: {}, renamedBs: "" };
    try {
      documentSync = await this.downloadTicketCltDocuments(normalized, fm);
    } catch (error) {
      console.warn(`[ServiceNow Manage] ${normalized} AI 프롬프트용 문서 확인 실패`, error);
      const reason = String(error.message || error);
      documentSync.failures.GENERAL = reason;
      messages.push(`관련 문서 확인에 실패했지만 나머지 정보로 프롬프트를 생성했습니다: ${reason}`);
    }

    let savedImages = 0;
    try {
      savedImages = await this.persistTicketAttachmentImages(normalized, ticket);
    } catch (error) {
      console.warn(`[ServiceNow Manage] ${normalized} AI 프롬프트용 이미지 저장 실패`, error);
      messages.push(`ServiceNow 이미지 저장에 실패했지만 나머지 정보로 프롬프트를 생성했습니다: ${error.message || error}`);
    }
    ticket.documentDownloadFailures = { ...documentSync.failures };
    ticket.documentDownloadCheckedAt = new Date().toISOString();
    this.data.tickets[normalized] = ticket;
    await this.savePluginData();
    const workNotes = (ticket.entries || [])
      .filter((entry) => String(entry.type || "").toLowerCase() === "work note")
      .sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")))
      .map((entry) => entry.content || [entry.time, entry.author].filter(Boolean).join(" - "))
      .filter(Boolean)
      .join("\n\n");

    const numberLabel = category === "CR" ? "CR No" : "SR No";
    prompt = replacePromptField(prompt, numberLabel, "Short Description", normalized);
    prompt = replacePromptField(prompt, "Short Description", "Long Description", ticket.shortDescription || "");
    const longDescription = ticket.description
      || fm["Long Description"]
      || fm["long_description"]
      || fm.description
      || "(확인된 Long Description 없음)";
    prompt = replacePromptField(prompt, "Long Description", "My Position", longDescription);
    prompt = replacePromptField(
      prompt,
      "My Position",
      "Current Service now Status",
      String(this.organizationPack?.roleDescription || "Ticket coordinator / analyst")
    );
    prompt = replacePromptField(
      prompt,
      "Current Service now Status",
      "Service now Working note(시간순)",
      fm.status || ticket.state || ""
    );
    prompt = replacePromptWorkingNotes(prompt, workNotes);

    const documentValues = {
      BS: { link: fm.BS || "", local: documentSync.local.BS || "" },
      FS: { link: fm.FS || "", local: documentSync.local.FS || "" },
      DS: { link: fm.DS || "", local: documentSync.local.DS || "" },
      UT: { link: fm.ut || fm.UT || "", local: documentSync.local.UT || "" }
    };
    const documentAvailability = classifyPromptDocuments(documentValues, documentSync.failures);
    const { availableTypes, inaccessibleTypes } = documentAvailability;
    prompt = adaptPromptToAvailableDocuments(prompt, availableTypes, Boolean(documentSync.local.BS_KO));

    const documentLines = [
      "",
      "문서 사용 원칙:",
      "- 아래 로컬 경로에 직접 접근할 수 있으면 해당 파일을 읽어 분석하세요.",
      "- 로컬 경로에 접근할 수 없는 일반 채팅 AI라면 사용자가 이 채팅에 첨부한 동일 유형의 파일을 분석하세요.",
      "- 필요한 파일이 경로에도 없고 채팅에도 첨부되지 않았다면 내용을 추측하지 말고 사용자에게 파일 첨부를 요청하세요.",
      "- ServiceNow 및 Google Drive 원본 링크에 접근할 수 있다고 가정하지 마세요.",
      "",
      "티켓 및 분석 문서:",
      `- 티켓 노트: ${rootFile.path}`,
    ];
    for (const type of availableTypes) {
      documentLines.push(`- ${type} 로컬 파일: ${documentValues[type].local}`);
    }
    for (const type of inaccessibleTypes) {
      const reason = documentAvailability.failures[type]
        ? ` · 실패 사유: ${documentAvailability.failures[type]}`
        : "";
      documentLines.push(`- ${type}: 원본 링크는 등록되어 있으나 로컬 파일을 확보하지 못함${reason}`);
    }
    if (inaccessibleTypes.length) {
      documentLines.push(`- 중요: ${inaccessibleTypes.join("·")} 문서는 '없는 문서'가 아니라 '링크는 있으나 현재 접근할 수 없는 문서'입니다. 내용을 검토했다고 주장하지 말고 사용자에게 파일 첨부 또는 문서 권한 확인을 요청하세요.`);
    }
    if (documentSync.local.BS_KO) documentLines.push(`- BS-한글 번역본: ${documentSync.local.BS_KO}`);
    if (!availableTypes.length && !inaccessibleTypes.length) documentLines.push("- 분석 문서: 확인된 링크 또는 로컬 파일 없음");
    const imageContexts = serviceNowImageContext(ticket);
    if (imageContexts.length) {
      documentLines.push(
        "",
        "ServiceNow 이미지와 워킹노트 문맥:",
        "- 아래 이미지는 ServiceNow 첨부 시각을 기준으로 앞뒤 Work Note를 연결한 문맥상 위치입니다. ServiceNow가 본문 내 직접 삽입 관계를 제공하지 않은 경우 확정 관계로 단정하지 마세요."
      );
      for (const { entry, before, after } of imageContexts) {
        documentLines.push(
          `- 이미지 로컬 파일: ${this.absoluteVaultPath(entry.localPath)}`,
          `  - 첨부 정보: ${[entry.time, entry.author, entry.content].filter(Boolean).join(" · ")}`,
          `  - 직전 Work Note: ${workNoteContextSnippet(before)}`,
          `  - 직후 Work Note: ${workNoteContextSnippet(after)}`
        );
      }
      documentLines.push("- 분석 시 이미지의 화면·오류·표·강조 표시를 읽고, 위 앞뒤 Work Note와 함께 해석하세요.");
    } else {
      documentLines.push("- ServiceNow 로컬 이미지: 확인된 이미지 첨부 없음");
    }
    const documentBlock = documentLines.join("\n");
    const environmentBlock = buildAiEnvironmentInstructions(category, {
      templatePath: this.absoluteVaultPath(this.analysisTemplatePath(category)),
      ticketPath: this.absoluteVaultPath(rootFile.path),
      assetsPath: this.absoluteVaultPath(this.ticketAssetsFolder(normalized))
    });
    prompt = `${prompt.trim()}\n\n${environmentBlock}\n${documentBlock}\n`;

    if (documentSync.downloaded.length) {
      messages.push(`${documentSync.downloaded.join("·")} 문서를 ${this.ticketAssetsFolder(normalized)}에 저장했습니다.`);
    }
    if (savedImages) messages.push(`ServiceNow 이미지 ${savedImages}개를 ${this.ticketAssetsFolder(normalized)}/ServiceNow에 저장했습니다.`);
    if (documentSync.renamedBs) messages.push(`BS 문서를 ${documentSync.renamedBs}로 자동 정리했습니다.`);
    if (!documentSync.local.BS && fm.BS) {
      messages.push(`BS는 별도 권한이 필요한 문서이므로 ${this.ticketAssetsFolder(normalized)}에 직접 다운로드해 주세요.`);
    }
    messages.push(...documentSync.warnings);
    return { prompt, messages, availableTypes };
  }

  async autoCreateWorkNotesForFile(file, allowExisting = false) {
    if (!this.settings.autoCreateWorkNotes || this.autoLinking.has(file.path)) return;
    if (!allowExisting && !this.pendingNewTicketFiles.has(file.path)) return;
    const ticketId = this.rootTicketIdFromFile(file);
    if (!ticketId) return;

    this.autoLinking.add(file.path);
    try {
      if (allowExisting) {
        await this.openOrCreateWorkNotes(file, { open: false, ticketId });
        this.pendingNewTicketFiles.delete(file.path);
        return;
      }
      const synced = await this.initializeNewTicket(file, ticketId);
      this.pendingNewTicketFiles.delete(file.path);
      this.queueTicketChangeNotice({
        kind: "worknotes",
        ticketId,
        failed: !synced,
        message: synced
          ? `${ticketId} 워킹노트 생성·상태·최초 데이터 갱신을 완료했습니다.`
          : `${ticketId} 워킹노트를 연결했지만 최초 갱신에 실패했습니다. 워킹노트에서 다시 시도해 주세요.`,
        duration: 7000
      });
    } finally {
      this.autoLinking.delete(file.path);
    }
  }

  async initializeNewTicket(parentFile, ticketId) {
    const normalized = normalizeTicketId(ticketId || this.ticketIdFromFile(parentFile));
    if (!normalized) return null;
    await this.ensureFolder(this.ticketAssetsFolder(normalized));
    const existingTicket = this.data.tickets[normalized];
    const wasPreviouslySynced = Boolean(existingTicket?.lastSyncedAt);
    const frontmatter = this.app.metadataCache.getFileCache(parentFile)?.frontmatter || {};
    const hasExistingDocumentLink = [frontmatter.BS, frontmatter.FS, frontmatter.DS, frontmatter.ut]
      .some((value) => Boolean(String(value || "").trim()));
    await this.openOrCreateWorkNotes(parentFile, { open: false, ticketId: normalized });
    const fresh = await this.syncTicket(normalized, { rootFile: parentFile });
    const shouldSearchDocuments = fresh
      && this.documentAutomationEnabled()
      && this.settings.autoDocumentSearchOnNewTicket
      && !existingTicket?.documentSearchInitialized
      && !wasPreviouslySynced
      && !hasExistingDocumentLink;
    if (shouldSearchDocuments) {
      await this.refreshTicketDocuments(normalized, { ticket: fresh, initial: true });
    }
    if (fresh) {
      fresh.documentSearchInitialized = true;
      await this.savePluginData();
    }
    return fresh;
  }

  async openOrCreateWorkNotes(parentFile, options = {}) {
    const ticketId = normalizeTicketId(options.ticketId || this.ticketIdFromFile(parentFile));
    if (!ticketId) {
      new Notice("현재 노트의 id 또는 파일명에서 CR/SR/INC 번호를 확인할 수 없습니다.");
      return;
    }
    const fm = this.app.metadataCache.getFileCache(parentFile)?.frontmatter || {};
    let target = await this.resolveExistingWorkNotes(parentFile, fm);
    if (!target) {
      const folder = this.settings.workNotesFolder
        ? normalizePath(this.settings.workNotesFolder)
        : parentFile.parent?.path || "";
      await this.ensureFolder(folder);
      const targetPath = normalizePath(`${folder ? `${folder}/` : ""}${ticketId} 워킹노트.md`);
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        target = existing;
      } else {
        const template = await this.readTemplate(this.workNotesTemplatePath(), defaultWorkNotesTemplate());
        target = await this.app.vault.create(targetPath, fillTemplate(template, {
          ticketId,
          parentName: parentFile.basename
        }));
      }
    }

    if (target.stat.size === 0) {
      const template = await this.readTemplate(this.workNotesTemplatePath(), defaultWorkNotesTemplate());
      await this.app.vault.process(target, () => fillTemplate(template, {
        ticketId,
        parentName: parentFile.basename
      }));
    }

    await this.app.fileManager.processFrontMatter(parentFile, (frontmatter) => {
      frontmatter["워킹노트"] = `[[${target.basename}]]`;
    });
    if (!this.data.tickets[ticketId]) {
      this.data.tickets[ticketId] = {
        ticketId,
        shortDescription: "",
        description: "",
        entries: [],
        lastSyncedAt: "",
        lastAttemptAt: "",
        lastError: ""
      };
      await this.savePluginData();
    }
    if (options.open !== false) await this.app.workspace.getLeaf(false).openFile(target);
  }

  async connectServiceNow() {
    if (this.settings.authMode === "bearer") {
      new BearerTokenModal(this.app, this).open();
      return;
    }
    const instanceUrl = cleanInstanceUrl(this.settings.instanceUrl);
    if (!instanceUrl || !this.settings.clientId) {
      new Notice("설정에서 ServiceNow 주소와 OAuth client ID를 먼저 입력하세요.", 6000);
      this.app.setting?.open?.();
      this.app.setting?.openTabById?.(PLUGIN_ID);
      return;
    }
    let redirect;
    try { redirect = new URL(this.settings.redirectUri); }
    catch (_) { return new Notice("OAuth callback URL 형식이 올바르지 않습니다."); }
    if (!['127.0.0.1', 'localhost'].includes(redirect.hostname) || redirect.protocol !== "http:") {
      return new Notice("현재 버전은 http://127.0.0.1 또는 localhost callback만 지원합니다.", 7000);
    }

    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(24).toString("base64url");
    this.pendingOAuth = { verifier, state };
    await this.startOAuthServer(redirect);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state
    });
    if (this.settings.oauthScope) params.set("scope", this.settings.oauthScope);
    await shell.openExternal(`${instanceUrl}/oauth_auth.do?${params.toString()}`);
    new Notice("브라우저에서 ServiceNow 로그인을 완료하세요.", 6000);
  }

  async startOAuthServer(redirect) {
    if (this.oauthServer) {
      try { this.oauthServer.close(); } catch (_) { /* no-op */ }
    }
    this.oauthServer = http.createServer(async (req, res) => {
      const requestUrlObject = new URL(req.url, this.settings.redirectUri);
      if (requestUrlObject.pathname !== redirect.pathname) {
        res.writeHead(404); res.end("Not found"); return;
      }
      const code = requestUrlObject.searchParams.get("code");
      const state = requestUrlObject.searchParams.get("state");
      const error = requestUrlObject.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body style='font-family:sans-serif;padding:40px'><h2>Obsidian으로 돌아가도 됩니다.</h2><p>이 창을 닫으세요.</p></body></html>");
      this.oauthServer.close();
      this.oauthServer = null;
      if (error) return new Notice(`ServiceNow 연결이 거부되었습니다: ${error}`, 7000);
      if (!code || !this.pendingOAuth || state !== this.pendingOAuth.state) {
        return new Notice("OAuth 응답을 확인할 수 없습니다. 다시 연결하세요.", 7000);
      }
      try {
        await this.exchangeAuthorizationCode(code, this.pendingOAuth.verifier);
        new Notice("ServiceNow 연결이 완료되었습니다.", 6000);
        this.views.forEach((views) => views.forEach((view) => view.render()));
      } catch (exchangeError) {
        new Notice(`ServiceNow 연결 실패: ${exchangeError.message}`, 9000);
      } finally {
        this.pendingOAuth = null;
      }
    });
    await new Promise((resolve, reject) => {
      this.oauthServer.once("error", reject);
      this.oauthServer.listen(Number(redirect.port || 80), redirect.hostname, resolve);
    });
  }

  async tokenRequest(params) {
    const response = await requestUrl({
      url: `${cleanInstanceUrl(this.settings.instanceUrl)}/oauth_token.do`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const message = response.json?.error_description || response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(message).slice(0, 300));
    }
    return response.json;
  }

  async exchangeAuthorizationCode(code, verifier) {
    const token = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.settings.redirectUri,
      client_id: this.settings.clientId,
      code_verifier: verifier
    });
    this.setSecret(ACCESS_TOKEN_KEY, token.access_token);
    if (token.refresh_token) this.setSecret(REFRESH_TOKEN_KEY, token.refresh_token);
    this.settings.tokenExpiresAt = Date.now() + Number(token.expires_in || 1800) * 1000;
    this.settings.connectedAt = localIsoDateTime();
    await this.savePluginData();
  }

  async saveManualBearerToken(token) {
    this.setSecret(ACCESS_TOKEN_KEY, cleanBearerToken(token));
    this.deleteSecret(REFRESH_TOKEN_KEY);
    this.settings.authMode = "bearer";
    this.settings.tokenExpiresAt = 0;
    this.settings.connectedAt = "";
    await this.savePluginData();
  }

  async testConnection() {
    const ticketId = Object.keys(this.data.tickets).map(normalizeTicketId).find(Boolean) || "";
    const table = ticketId ? this.serviceNowTableForTicket(ticketId) : (this.settings.changeRequestTable || "change_request");
    const response = await this.apiGet(`/api/now/table/${table}`, {
      ...(ticketId ? { sysparm_query: `number=${ticketId}` } : {}),
      sysparm_fields: "sys_id,number,short_description",
      sysparm_limit: 1
    });
    if (ticketId && !response.result?.length) {
      throw new Error(`${ticketId} 조회 결과가 없습니다. 토큰 권한과 티켓 접근 범위를 확인하세요.`);
    }
    this.settings.connectedAt = localIsoDateTime();
    await this.savePluginData();
    new Notice(ticketId
      ? `ServiceNow 연결 확인 완료 · ${ticketId} 조회 가능`
      : "ServiceNow 연결 확인 완료 · Change Request API 접근 가능", 7000);
    return true;
  }

  async refreshAccessToken() {
    const refreshToken = this.getSecret(REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new Error("다시 로그인이 필요합니다.");
    const token = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.settings.clientId
    });
    this.setSecret(ACCESS_TOKEN_KEY, token.access_token);
    if (token.refresh_token) this.setSecret(REFRESH_TOKEN_KEY, token.refresh_token);
    this.settings.tokenExpiresAt = Date.now() + Number(token.expires_in || 1800) * 1000;
    await this.savePluginData();
    return token.access_token;
  }

  async validAccessToken() {
    const accessToken = this.getSecret(ACCESS_TOKEN_KEY);
    if (!accessToken) throw new Error("ServiceNow 연결이 필요합니다.");
    if (!this.settings.tokenExpiresAt || Date.now() < this.settings.tokenExpiresAt - 60_000) return accessToken;
    return this.refreshAccessToken();
  }

  async disconnectServiceNow() {
    const tokens = [this.getSecret(ACCESS_TOKEN_KEY), this.getSecret(REFRESH_TOKEN_KEY)].filter(Boolean);
    if (this.settings.authMode === "oauth") {
      for (const token of tokens) {
        try {
          await requestUrl({
            url: `${cleanInstanceUrl(this.settings.instanceUrl)}/oauth_revoke_token.do?token=${encodeURIComponent(token)}`,
            method: "GET",
            throw: false
          });
        } catch (_) { /* local cleanup still proceeds */ }
      }
    }
    this.deleteSecret(ACCESS_TOKEN_KEY);
    this.deleteSecret(REFRESH_TOKEN_KEY);
    this.settings.tokenExpiresAt = 0;
    this.settings.connectedAt = "";
    await this.savePluginData();
    new Notice("ServiceNow 연결을 해제했습니다.");
  }

  organizationPackPath() {
    const configDir = this.app.vault.configDir || ".obsidian";
    return normalizePath(`${configDir}/plugins/${PLUGIN_ID}/organization-pack.json`);
  }

  validateOrganizationPack(pack) {
    if (!pack || Number(pack.schemaVersion) !== 1) throw new Error("지원하지 않는 업무가이드팩 형식입니다.");
    if (!String(pack.packId || "").trim() || !String(pack.name || "").trim()) {
      throw new Error("packId 또는 name이 없습니다.");
    }
    if (!pack.statusGuides && !pack.analysisTemplates && !pack.promptTemplate) {
      throw new Error("상태 가이드나 분석 템플릿이 없는 팩입니다.");
    }
    return pack;
  }

  async loadOrganizationPack() {
    try {
      const raw = await this.app.vault.adapter.read(this.organizationPackPath());
      return this.validateOrganizationPack(JSON.parse(raw));
    } catch (_) {
      return null;
    }
  }

  hasOrganizationPack() {
    return Boolean(this.organizationPack?.packId);
  }

  organizationFeatureEnabled(feature) {
    if (!this.settings.organizationFeaturesEnabled || !this.hasOrganizationPack()) return false;
    return this.organizationPack.features?.[feature] !== false;
  }

  organizationFeaturesEnabled() {
    return this.organizationFeatureEnabled("statusGuides") || this.organizationFeatureEnabled("aiPrompt");
  }

  documentAutomationEnabled() {
    return Boolean(this.settings.enableDocumentAutomation || (
      this.settings.organizationFeaturesEnabled
      && this.organizationPack?.features?.documentAutomation
    ));
  }

  importOrganizationPack(onDone) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const pack = await this.applyOrganizationPack(JSON.parse(await file.text()));
        const templateResult = this.lastOrganizationPackApplyResult || {};
        new Notice(`업무가이드팩을 등록했습니다: ${pack.name}${templateResult.updated ? ` · 기본 템플릿 갱신 ${templateResult.updated}개` : ""}${templateResult.preserved ? ` · 사용자 수정 템플릿 보존 ${templateResult.preserved}개` : ""}`, 8000);
        onDone?.();
      } catch (error) {
        new Notice(`업무가이드팩 등록 실패: ${error.message || error}`, 10000);
      }
    }, { once: true });
    input.click();
  }

  async applyOrganizationPack(value) {
    const previousPack = this.organizationPack;
    const pack = this.validateOrganizationPack(value);
    await this.app.vault.adapter.write(this.organizationPackPath(), `${JSON.stringify(pack, null, 2)}\n`);
    this.organizationPack = pack;
    this.settings.organizationFeaturesEnabled = true;
    const templateResult = await this.ensureOrganizationTemplates({ previousPack });
    await this.savePluginData();
    this.lastOrganizationPackApplyResult = templateResult;
    return pack;
  }

  async removeOrganizationPack(onDone) {
    try {
      if (await this.app.vault.adapter.exists(this.organizationPackPath())) {
        await this.app.vault.adapter.remove(this.organizationPackPath());
      }
      this.organizationPack = null;
      this.settings.organizationFeaturesEnabled = false;
      await this.savePluginData();
      new Notice("업무가이드팩을 제거했습니다. 기존 Vault 문서는 삭제하지 않습니다.", 7000);
      onDone?.();
    } catch (error) {
      new Notice(`업무가이드팩 제거 실패: ${error.message || error}`, 9000);
    }
  }

  async ensureOrganizationTemplates(options = {}) {
    if (!this.settings.organizationFeaturesEnabled || !this.hasOrganizationPack()) return;
    await this.ensureFolder(normalizePath(`${this.rootFolder()}/지침`));
    const files = [
      [
        this.aiPromptTemplatePath(),
        this.organizationPack.promptTemplate || defaultAiPromptTemplate(),
        options.previousPack?.promptTemplate || defaultAiPromptTemplate()
      ],
      [
        this.analysisTemplatePath("CR"),
        this.organizationPack.analysisTemplates?.CR || "",
        options.previousPack?.analysisTemplates?.CR || ""
      ],
      [
        this.analysisTemplatePath("SR"),
        this.organizationPack.analysisTemplates?.SR || "",
        options.previousPack?.analysisTemplates?.SR || ""
      ]
    ];
    const result = { created: 0, updated: 0, preserved: 0 };
    for (const [filePath, content, previousContent] of files) {
      if (!content) continue;
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (!(existing instanceof TFile)) {
        await this.app.vault.create(filePath, content);
        result.created += 1;
        continue;
      }
      if (!options.previousPack || content === previousContent) continue;
      const currentContent = await this.app.vault.read(existing);
      if (currentContent === previousContent) {
        await this.app.vault.modify(existing, content);
        result.updated += 1;
      } else {
        result.preserved += 1;
      }
    }
    return result;
  }

  importGoogleOAuthJson(onDone) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await this.applyGoogleOAuthJson(JSON.parse(await file.text()));
        new Notice("Google Desktop OAuth JSON을 등록했습니다. 이제 Google 계정을 연결할 수 있습니다.", 8000);
        onDone?.();
      } catch (error) {
        new Notice(`Google OAuth JSON 등록 실패: ${error.message || error}`, 10000);
      }
    }, { once: true });
    input.click();
  }

  async applyGoogleOAuthJson(value) {
    const credentials = value?.installed || value?.web;
    const clientId = String(credentials?.client_id || "").trim();
    const clientSecret = String(credentials?.client_secret || "").trim();
    if (!clientId || !clientSecret) throw new Error("client_id 또는 client_secret을 찾을 수 없습니다.");
    this.settings.googleClientId = clientId;
    this.setSecret(GOOGLE_CLIENT_SECRET_KEY, clientSecret);
    await this.savePluginData();
    return { clientId };
  }

  googleOAuthCredentials() {
    const clientId = String(this.settings.googleClientId || "").trim();
    const clientSecret = this.getSecret(GOOGLE_CLIENT_SECRET_KEY);
    if (!clientId || !clientSecret) {
      throw new Error("설정에서 Google Desktop OAuth JSON을 먼저 선택하세요.");
    }
    return { clientId, clientSecret };
  }

  hasGoogleDriveDownloadScope(scopes) {
    const list = Array.isArray(scopes)
      ? scopes
      : String(scopes || "").split(/\s+/).filter(Boolean);
    if (!list.length) return false;
    return list.some((s) => {
      const lower = String(s).toLowerCase();
      return lower.includes("/auth/drive.readonly")
        || lower.endsWith("/auth/drive")
        || lower === "https://www.googleapis.com/auth/drive";
    });
  }

  getGooglePermissionInfo() {
    const connected = Boolean(this.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    if (!connected) {
      return {
        connected: false,
        hasDownloadPermission: false,
        hasMetadataPermission: false,
        scopes: [],
        permissionLabel: "",
        badge: "",
        needsReauth: false
      };
    }
    const grantedScopes = String(this.settings.googleGrantedScopes || "").split(/\s+/).filter(Boolean);
    const hasDownload = this.hasGoogleDriveDownloadScope(grantedScopes);
    const hasMetadata = grantedScopes.some((s) => s.toLowerCase().includes("/auth/drive.metadata"));
    const hasDownloadPermission = hasDownload || (this.settings.googleDriveContentAccess === true && !grantedScopes.length);
    const hasMetadataPermission = hasMetadata || hasDownloadPermission;

    let permissionLabel = "";
    let badge = "";
    let needsReauth = false;

    if (hasDownloadPermission) {
      permissionLabel = "파일 보기 및 다운로드 (drive.readonly)";
      badge = "🟢 파일 다운로드 권한 보유";
    } else if (hasMetadataPermission || this.settings.googleDriveContentAccess === false) {
      permissionLabel = "메타데이터 전용 (drive.metadata.readonly · 다운로드 권한 없음)";
      badge = "⚠️ 메타데이터 전용 (재인증 필요)";
      needsReauth = true;
    } else {
      permissionLabel = "권한 확인 필요 (이전 방식 연결)";
      badge = "⚠️ 재인증 필요";
      needsReauth = true;
    }

    return {
      connected: true,
      hasDownloadPermission,
      hasMetadataPermission,
      scopes: grantedScopes,
      permissionLabel,
      badge,
      needsReauth
    };
  }

  async inspectGoogleTokenScopes() {
    try {
      const token = await this.validGoogleAccessToken();
      const response = await requestUrl({
        url: `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(token)}`,
        method: "GET",
        headers: { Accept: "application/json" },
        throw: false
      });
      if (response.status >= 200 && response.status < 300 && response.json?.scope) {
        const rawScope = String(response.json.scope || "").trim();
        this.settings.googleGrantedScopes = rawScope;
        this.settings.googleDriveContentAccess = this.hasGoogleDriveDownloadScope(rawScope);
        if (response.json.email && !this.settings.googleAccountEmail) {
          this.settings.googleAccountEmail = response.json.email;
        }
        await this.savePluginData();
        return { success: true, scope: rawScope, hasDownload: this.settings.googleDriveContentAccess };
      }
    } catch (error) {
      console.warn("[ServiceNow Manage] Google tokeninfo 확인 실패", error);
    }
    return { success: false, scope: "", hasDownload: Boolean(this.settings.googleDriveContentAccess) };
  }

  async connectGoogleDrive() {
    let clientId;
    try {
      ({ clientId } = this.googleOAuthCredentials());
    } catch (error) {
      new Notice(error.message, 8000);
      return;
    }
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(24).toString("base64url");
    const redirectUri = "http://127.0.0.1:42814/oauth/callback";
    this.pendingGoogleOAuth = { verifier, state, redirectUri };
    await this.startGoogleOAuthServer();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.metadata.readonly",
      access_type: "offline",
      prompt: "consent select_account",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state
    });
    await shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    new Notice("브라우저에서 Google 계정을 선택하고 Drive 문서 읽기 및 다운로드 권한을 승인하세요.", 8000);
  }

  async startGoogleOAuthServer() {
    if (this.googleOAuthServer) {
      try { this.googleOAuthServer.close(); } catch (_) { /* no-op */ }
    }
    this.googleOAuthServer = http.createServer(async (req, res) => {
      const request = new URL(req.url, "http://127.0.0.1:42814");
      if (request.pathname !== "/oauth/callback") {
        res.writeHead(404); res.end("Not found"); return;
      }
      const code = request.searchParams.get("code");
      const state = request.searchParams.get("state");
      const error = request.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body style='font-family:sans-serif;padding:40px'><h2>Google Drive 연결 처리 완료</h2><p>Obsidian으로 돌아가세요.</p></body></html>");
      this.googleOAuthServer.close();
      this.googleOAuthServer = null;
      if (error) return new Notice(`Google 연결이 거부되었습니다: ${error}`, 8000);
      if (!code || !this.pendingGoogleOAuth || state !== this.pendingGoogleOAuth.state) {
        return new Notice("Google OAuth 응답을 확인할 수 없습니다. 다시 연결하세요.", 8000);
      }
      try {
        await this.exchangeGoogleAuthorizationCode(code, this.pendingGoogleOAuth);
        const about = await this.googleDriveApiGet("/drive/v3/about", { fields: "user(displayName,emailAddress)" });
        this.settings.googleAccountEmail = about.user?.emailAddress || about.user?.displayName || "";
        this.settings.googleConnectedAt = localIsoDateTime();
        await this.savePluginData();
        const permission = this.getGooglePermissionInfo();
        const scopeNotice = permission.hasDownloadPermission ? " · 파일 다운로드 권한 확인됨" : " · 파일 다운로드 권한 누락 (재인증 필요)";
        new Notice(`Google Drive 연결 완료 · ${this.settings.googleAccountEmail || "계정 확인됨"}${scopeNotice}`, 8000);
        if (this.workNotesSettingTab?.containerEl?.isShown()) {
          this.workNotesSettingTab.display();
        }
      } catch (exchangeError) {
        new Notice(`Google Drive 연결 실패: ${exchangeError.message || exchangeError}`, 10000);
      } finally {
        this.pendingGoogleOAuth = null;
      }
    });
    await new Promise((resolve, reject) => {
      this.googleOAuthServer.once("error", reject);
      this.googleOAuthServer.listen(42814, "127.0.0.1", resolve);
    });
  }

  async googleTokenRequest(params) {
    const response = await requestUrl({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error_description || response.json?.error || response.text || `HTTP ${response.status}`;
      throw new Error(String(detail).slice(0, 400));
    }
    return response.json;
  }

  async exchangeGoogleAuthorizationCode(code, pending) {
    const { clientId, clientSecret } = this.googleOAuthCredentials();
    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: pending.verifier
    };
    const token = await this.googleTokenRequest(params);
    this.setSecret(GOOGLE_ACCESS_TOKEN_KEY, token.access_token);
    if (token.refresh_token) this.setSecret(GOOGLE_REFRESH_TOKEN_KEY, token.refresh_token);
    this.settings.googleTokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
    const rawScope = String(token.scope || "").trim();
    if (rawScope) {
      this.settings.googleGrantedScopes = rawScope;
      this.settings.googleDriveContentAccess = this.hasGoogleDriveDownloadScope(rawScope);
    } else {
      await this.inspectGoogleTokenScopes();
    }
    await this.savePluginData();
  }

  async validGoogleAccessToken() {
    const accessToken = this.getSecret(GOOGLE_ACCESS_TOKEN_KEY);
    if (accessToken && Date.now() < Number(this.settings.googleTokenExpiresAt || 0) - 60_000) return accessToken;
    const refreshToken = this.getSecret(GOOGLE_REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new Error("설정에서 Google Drive 계정을 연결하세요.");
    const { clientId, clientSecret } = this.googleOAuthCredentials();
    const params = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    };
    const token = await this.googleTokenRequest(params);
    this.setSecret(GOOGLE_ACCESS_TOKEN_KEY, token.access_token);
    this.settings.googleTokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
    await this.savePluginData();
    return token.access_token;
  }

  async googleDriveApiGet(path, query = {}) {
    const token = await this.validGoogleAccessToken();
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    });
    const response = await requestUrl({
      url: `https://www.googleapis.com${path}${params.size ? `?${params}` : ""}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error?.message || response.text || `HTTP ${response.status}`;
      throw new Error(String(detail).slice(0, 400));
    }
    return response.json;
  }

  async googleDriveBinaryGet(path, query = {}) {
    const token = await this.validGoogleAccessToken();
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    });
    const response = await requestUrl({
      url: `https://www.googleapis.com${path}${params.size ? `?${params}` : ""}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error?.message || response.text || `HTTP ${response.status}`;
      throw new Error(String(detail).slice(0, 400));
    }
    return response.arrayBuffer;
  }

  findLocalTicketDocument(ticketId, type) {
    const normalizedType = String(type || "").toUpperCase();
    const folders = normalizedType === "BS"
      ? [`${this.ticketAssetsFolder(ticketId)}/`, `${this.ticketDocumentsFolder(ticketId)}/`]
      : [`${this.ticketAssetsFolder(ticketId)}/`];
    const prefix = `${normalizeTicketId(ticketId)} ${normalizedType}`;
    const candidates = this.app.vault.getFiles().filter((file) =>
      folders.some((folder) => file.path.startsWith(folder))
        && (
          file.basename.toUpperCase().startsWith(prefix.toUpperCase())
          || documentTypeFromFileName(file.basename) === normalizedType
        )
        && (normalizedType !== "BS" || !/BS[-_\s]*한글/i.test(file.basename))
    );
    candidates.sort((left, right) => {
      const leftPrefixed = left.basename.toUpperCase().startsWith(prefix.toUpperCase()) ? 0 : 1;
      const rightPrefixed = right.basename.toUpperCase().startsWith(prefix.toUpperCase()) ? 0 : 1;
      return leftPrefixed - rightPrefixed || left.path.localeCompare(right.path, "ko");
    });
    return candidates[0]?.path || "";
  }

  findLocalBsTranslation(ticketId) {
    const folder = `${this.ticketAssetsFolder(ticketId)}/`;
    const prefix = `${normalizeTicketId(ticketId)} BS-`;
    const candidates = this.app.vault.getFiles().filter((file) =>
      file.path.startsWith(folder)
        && file.basename.toUpperCase().startsWith(prefix.toUpperCase())
        && /BS[-_\s]*한글/i.test(file.basename)
    );
    candidates.sort((left, right) =>
      Number(right.stat?.mtime || 0) - Number(left.stat?.mtime || 0)
        || left.path.localeCompare(right.path, "ko")
    );
    return candidates[0]?.path || "";
  }

  ticketIdFromAssetsPath(path) {
    const prefix = `${this.ticketsFolder()}/`;
    const relative = normalizePath(String(path || ""));
    if (!relative.startsWith(prefix)) return "";
    const parts = relative.slice(prefix.length).split("/");
    const ticketId = normalizeTicketId(parts[0]);
    return /^(?:CR|SR)\d+$/.test(ticketId) && parts[1] === "assets" ? ticketId : "";
  }

  async onTicketAssetChanged(file) {
    if (!(file instanceof TFile)) return;
    const ticketId = this.ticketIdFromAssetsPath(file.path);
    if (!ticketId || this.linkingLocalBs.has(ticketId)) return;
    const type = documentTypeFromFileName(file.basename);
    if (type && type !== "BS") return;
    if (/BS[-_\s]*한글/i.test(file.basename)) return;
    const supported = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
    if (!supported.has(String(file.extension || "").toLowerCase())) return;
    this.linkingLocalBs.add(ticketId);
    try {
      const bs = await this.normalizeManualBsDocument(ticketId);
      const linked = await this.linkLocalBsDocument(ticketId, bs.path);
      if (bs.renamed || linked.changed) {
        this.queueTicketChangeNotice({
          kind: "documents",
          ticketId,
          message: `${ticketId} 로컬 BS 문서를 티켓 노트에 연결했습니다.`,
          duration: 6000
        });
      }
    } catch (error) {
      console.error(`[ServiceNow Manage] ${ticketId} 로컬 BS 연결 실패`, error);
    } finally {
      this.linkingLocalBs.delete(ticketId);
    }
  }

  async linkExistingLocalBsDocuments() {
    for (const rootFile of this.rootTicketFiles()) {
      const ticketId = this.rootTicketIdFromFile(rootFile);
      if (!ticketId || this.linkingLocalBs.has(ticketId)) continue;
      this.linkingLocalBs.add(ticketId);
      try {
        const bs = await this.normalizeManualBsDocument(ticketId);
        await this.linkLocalBsDocument(ticketId, bs.path);
      } catch (error) {
        console.error(`[ServiceNow Manage] ${ticketId} 기존 로컬 BS 연결 실패`, error);
      } finally {
        this.linkingLocalBs.delete(ticketId);
      }
    }
  }

  async linkLocalBsDocument(ticketId, path) {
    if (!path) return { changed: false, value: "", source: "" };
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (!(rootFile instanceof TFile)) return { changed: false, value: "", source: "" };
    const remoteCandidates = extractDescriptionLinks(this.data.tickets[normalized]?.description || "");
    const localLink = `[[${normalizePath(path)}]]`;
    let result = { changed: false, value: "", source: "" };
    await this.app.fileManager.processFrontMatter(rootFile, (frontmatter) => {
      const current = String(frontmatter.BS || "").trim();
      const currentIsLocal = isLocalBsWikiLink(current, this.ticketAssetsFolder(normalized));
      if (remoteCandidates.length === 1 && (!current || currentIsLocal)) {
        const remote = remoteCandidates[0].url;
        if (current !== remote) frontmatter.BS = remote;
        result = { changed: current !== remote, value: remote, source: "ServiceNow Description" };
        return;
      }
      if (remoteCandidates.length > 0) return;
      if (!current || currentIsLocal) {
        if (current !== localLink) frontmatter.BS = localLink;
        result = { changed: current !== localLink, value: localLink, source: "local" };
      }
    });
    return result;
  }

  async linkLocalBsTranslation(ticketId, path) {
    if (!path) return;
    const rootFile = this.rootTicketFile(ticketId);
    if (!(rootFile instanceof TFile)) return;
    const link = `[[${path}]]`;
    await this.app.fileManager.processFrontMatter(rootFile, (frontmatter) => {
      frontmatter["BS-한글"] = link;
    });
  }

  async normalizeManualBsDocument(ticketId) {
    const existing = this.findLocalTicketDocument(ticketId, "BS");
    if (existing) {
      const source = this.app.vault.getAbstractFileByPath(existing);
      if (
        !(source instanceof TFile)
        || source.parent?.path !== this.ticketAssetsFolder(ticketId)
        || isStandardBsFileName(ticketId, source.basename)
      ) return { path: existing, renamed: "", warning: "" };
      return this.renameLocalBsToStandard(ticketId, source);
    }
    const assetsPrefix = `${this.ticketAssetsFolder(ticketId)}/`;
    const supported = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
    const candidates = this.app.vault.getFiles().filter((file) =>
      file.parent?.path === this.ticketAssetsFolder(ticketId)
        && file.path.startsWith(assetsPrefix)
        && supported.has(String(file.extension || "").toLowerCase())
        && !documentTypeFromFileName(file.basename)
    );
    if (candidates.length !== 1) {
      return {
        path: "",
        renamed: "",
        warning: candidates.length > 1
          ? `BS로 판단할 수 있는 문서가 ${candidates.length}개입니다. BS 파일명에 BS를 넣어 주세요.`
          : ""
      };
    }
    return this.renameLocalBsToStandard(ticketId, candidates[0]);
  }

  async renameLocalBsToStandard(ticketId, source) {
    const extension = source.extension ? `.${source.extension}` : "";
    const base = standardBsBaseName(ticketId, source.basename);
    let target = normalizePath(`${this.ticketAssetsFolder(ticketId)}/${base}${extension}`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(target)) {
      target = normalizePath(`${this.ticketAssetsFolder(ticketId)}/${base} (${suffix})${extension}`);
      suffix += 1;
    }
    await this.app.fileManager.renameFile(source, target);
    return { path: target, renamed: target, warning: "" };
  }

  async saveDownloadedDocument(path, data) {
    const normalized = normalizePath(path);
    const parent = normalized.split("/").slice(0, -1).join("/");
    await this.ensureFolder(parent);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data);
    else await this.app.vault.createBinary(normalized, data);
    return normalized;
  }

  async downloadGoogleDriveDocument(ticketId, type, link) {
    const fileId = googleDriveFileId(link);
    if (!fileId) throw new Error("Google Drive 파일 ID를 확인할 수 없습니다.");
    const encodedId = encodeURIComponent(fileId);
    let metadata;
    try {
      metadata = await this.googleDriveApiGet(`/drive/v3/files/${encodedId}`, {
        fields: "id,name,mimeType,modifiedTime",
        supportsAllDrives: "true"
      });
    } catch (error) {
      if (String(error.message || "").includes("403") || /insufficient/i.test(String(error.message || ""))) {
        throw new Error("Google Drive 권한 부족 (Google 계정 연결 시 Drive 체크박스 권한 허용 또는 Cloud Console 테스트 사용자 등록 필요)");
      }
      throw error;
    }
    const format = googleDownloadFormat(metadata.mimeType, metadata.name);
    let data;
    try {
      data = format.native
        ? await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}/export`, {
            mimeType: format.exportMime,
            supportsAllDrives: "true"
          })
        : await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}`, {
            alt: "media",
            supportsAllDrives: "true",
            acknowledgeAbuse: "true"
          });
    } catch (downloadError) {
      if (String(downloadError.message || "").includes("403")) {
        throw new Error("파일 다운로드 권한 부족 (Google 권한 동의 체크박스 또는 공유 드라이브 접근 확인 필요)");
      }
      throw downloadError;
    }
    const target = `${this.ticketAssetsFolder(ticketId)}/${safeFileName(`${normalizeTicketId(ticketId)} ${type}`)}${format.extension}`;
    return this.saveDownloadedDocument(target, data);
  }

  async downloadTicketCltDocuments(ticketId, frontmatter) {
    const bs = await this.normalizeManualBsDocument(ticketId);
    const local = {
      BS: bs.path,
      BS_KO: this.findLocalBsTranslation(ticketId),
      FS: this.findLocalTicketDocument(ticketId, "FS"),
      DS: this.findLocalTicketDocument(ticketId, "DS"),
      UT: this.findLocalTicketDocument(ticketId, "UT")
    };
    const result = { downloaded: [], warnings: bs.warning ? [bs.warning] : [], failures: {}, local, renamedBs: bs.renamed, linkedBs: null };
    await this.linkLocalBsTranslation(ticketId, local.BS_KO);
    result.linkedBs = await this.linkLocalBsDocument(ticketId, local.BS);
    const links = {
      FS: frontmatter.FS,
      DS: frontmatter.DS,
      UT: frontmatter.ut || frontmatter.UT
    };
    if (!Object.values(links).some(Boolean)) return result;
    const cltConnected = Boolean(this.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    if (!cltConnected) return result;
    if (!this.settings.googleDriveContentAccess) {
      result.warnings.push("현재 Google 연결에 파일 다운로드 권한(drive.readonly)이 없습니다. 설정에서 [재인증 필요]를 눌러 Google 권한을 다시 승인해 주세요.");
      return result;
    }
    for (const [type, link] of Object.entries(links)) {
      if (!link) continue;
      try {
        result.local[type] = await this.downloadGoogleDriveDocument(ticketId, type, link);
        result.downloaded.push(type);
      } catch (error) {
        const reason = String(error.message || error);
        result.failures[type] = reason;
        result.warnings.push(`${type} 다운로드 실패: ${reason}`);
      }
    }
    result.local.BS = this.findLocalTicketDocument(ticketId, "BS");
    return result;
  }

  async searchGoogleDriveDocuments(ticketId) {
    const baseQuery = {
      q: `name contains '${ticketId}_' and trashed = false`,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      orderBy: "modifiedTime desc",
      pageSize: 100,
      spaces: "drive",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true"
    };
    const responses = [];
    for (const corpora of ["user", "allDrives"]) {
      try {
        responses.push(await this.googleDriveApiGet("/drive/v3/files", { ...baseQuery, corpora }));
      } catch (error) {
        if (corpora === "user") throw error;
        console.warn("[Google Drive] 공유 드라이브 통합 검색 제외", error);
      }
    }
    const filesById = new Map();
    responses.flatMap((response) => response.files || []).forEach((file) => filesById.set(file.id, file));
    const groups = { FS: [], DS: [], UT: [] };
    [...filesById.values()]
      .sort((left, right) => String(right.modifiedTime || "").localeCompare(String(left.modifiedTime || "")))
      .forEach((file) => {
      const match = String(file.name || "").toUpperCase().match(new RegExp(`^${ticketId}_(FS|DS|UT)(?:_|\\b)`));
      if (!match) return;
      groups[match[1]].push({
        type: match[1],
        name: file.name,
        url: file.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`,
        modifiedTime: file.modifiedTime ? localIsoDateTime(new Date(file.modifiedTime)) : "",
        source: "Google Drive"
      });
      });
    return groups;
  }

  async searchGoogleDriveMeetingDocuments(ticketId, searchText = "") {
    const normalized = normalizeTicketId(ticketId);
    const manualQuery = String(searchText || "").trim();
    const searchTerms = manualQuery.split(/\s+/).filter(Boolean);
    const escapeDriveQuery = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const nameQuery = searchTerms.length
      ? searchTerms.map((term) => `name contains '${escapeDriveQuery(term)}'`).join(" and ")
      : `name contains '${normalized}' and name contains 'Gemini가 작성한 회의록'`;
    const baseQuery = {
      q: `${nameQuery} and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
      fields: "files(id,name,mimeType,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress))",
      orderBy: "modifiedTime desc",
      pageSize: 100,
      spaces: "drive",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true"
    };
    const responses = [];
    for (const corpora of ["user", "allDrives"]) {
      try {
        responses.push(await this.googleDriveApiGet("/drive/v3/files", { ...baseQuery, corpora }));
      } catch (error) {
        if (corpora === "user") throw error;
        console.warn("[Google Drive] 공유 드라이브 회의록 검색 제외", error);
      }
    }
    const files = new Map();
    responses.flatMap((response) => response.files || []).forEach((file) => files.set(file.id, file));
    return [...files.values()]
      .filter((file) => {
        const name = String(file.name || "");
        if (searchTerms.length) {
          const comparableName = name.toLocaleLowerCase();
          return searchTerms.every((term) => comparableName.includes(term.toLocaleLowerCase()));
        }
        return name.toUpperCase().includes(normalized) && name.includes("Gemini가 작성한 회의록");
      })
      .map((file) => {
        const fallback = new Date(file.createdTime || file.modifiedTime || Date.now());
        return {
          ...file,
          meetingDate: parseMeetingDate(file.name, fallback),
          modifiedTime: file.modifiedTime ? localIsoDateTime(new Date(file.modifiedTime)).slice(0, 16) : "",
          owner: file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || ""
        };
      })
      .sort((left, right) => String(right.meetingDate).localeCompare(String(left.meetingDate)));
  }

  async importGoogleDriveMeeting(ticketId, candidate) {
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (!(rootFile instanceof TFile)) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);
    if (!candidate?.id) throw new Error("Google Drive 회의록 ID가 없습니다.");
    if (this.listTicketMeetings(normalized).some((meeting) => meeting.sourceDriveId === candidate.id)) {
      return { note: null, warnings: [`${candidate.name}: 이미 추가된 회의록입니다.`] };
    }
    const encodedId = encodeURIComponent(candidate.id);
    const markdownData = await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}/export`, {
      mimeType: "text/markdown"
    });
    const sourceText = new TextDecoder("utf-8").decode(markdownData);
    if (!sourceText.trim()) throw new Error(`${candidate.name}의 Markdown 내용이 비어 있습니다.`);
    const folder = this.ticketMeetingsFolder(normalized);
    await this.ensureFolder(folder);
    const meetingDate = candidate.meetingDate || parseMeetingDate(candidate.name);
    const titleFromBody = sourceText.match(/^##\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$/m)?.[1] || candidate.name;
    const title = cleanMeetingTitle(titleFromBody, normalized);
    const fileStem = `${meetingDate.slice(0, 10)} ${meetingDate.slice(11, 16).replace(":", "-")} - ${safeFileName(title).slice(0, 90)}`;
    const warnings = [];
    let pdfPath = "";
    try {
      const pdfData = await this.googleDriveBinaryGet(`/drive/v3/files/${encodedId}/export`, {
        mimeType: "application/pdf"
      });
      pdfPath = await this.uniqueVaultPath(`${folder}/${fileStem} - Gemini 원본.pdf`);
      await this.saveDownloadedDocument(pdfPath, pdfData);
    } catch (error) {
      warnings.push(`${candidate.name}: PDF 원본 저장 실패 - ${error.message || error}`);
    }
    const notePath = await this.uniqueVaultPath(`${folder}/${fileStem}.md`);
    const markdown = buildMeetingNoteMarkdown({
      ticketId: normalized,
      sourceName: candidate.name,
      sourceText,
      meetingDate,
      title,
      pdfPath,
      sourceDriveId: candidate.id
    });
    const note = await this.app.vault.create(notePath, markdown);
    await this.ensureMeetingSection(rootFile, normalized);
    return { note, warnings };
  }

  async refreshTicketDocuments(ticketId, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    const rootFile = this.rootTicketFile(normalized);
    if (!rootFile) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);
    let ticket = options.ticket || this.data.tickets[normalized];
    if (!ticket?.lastSyncedAt) ticket = await this.syncTicket(normalized, { rootFile });
    if (!ticket) throw new Error("ServiceNow 상세 내용을 먼저 가져오지 못했습니다.");

    const frontmatter = this.app.metadataCache.getFileCache(rootFile)?.frontmatter || {};
    const currentValues = {
      BS: String(frontmatter.BS || ""),
      FS: String(frontmatter.FS || ""),
      DS: String(frontmatter.DS || ""),
      UT: String(frontmatter.ut || "")
    };
    const candidateGroups = {
      BS: extractDescriptionLinks(ticket.description),
      FS: [],
      DS: [],
      UT: []
    };
    const warnings = [];
    const googleConnected = Boolean(this.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.getSecret(GOOGLE_ACCESS_TOKEN_KEY));
    if (googleConnected) {
      try {
        const driveGroups = await this.searchGoogleDriveDocuments(normalized);
        candidateGroups.FS = driveGroups.FS;
        candidateGroups.DS = driveGroups.DS;
        candidateGroups.UT = driveGroups.UT;
      } catch (error) {
        warnings.push(`Google Drive 검색 실패: ${error.message || error}`);
      }
    } else {
      warnings.push("Google Drive가 연결되지 않아 FS·DS·UT 검색을 건너뛰었습니다.");
    }

    const updates = {};
    const multiple = {};
    Object.entries(candidateGroups).forEach(([type, candidates]) => {
      if (options.initial && currentValues[type]) return;
      if (candidates.length === 1) updates[type] = candidates[0].url;
      if (candidates.length > 1) {
        multiple[type] = candidates;
      }
    });
    for (const type of ["BS", "FS", "DS", "UT"]) {
      const candidates = multiple[type];
      if (!candidates) continue;
      const selected = await new Promise((resolve) => {
        new DocumentCandidateModal(this.app, normalized, { [type]: candidates }, currentValues, resolve).open();
      });
      Object.assign(updates, selected);
    }

    const changedFields = Object.entries(updates).filter(([type, url]) => url && currentValues[type] !== url);
    if (changedFields.length) {
      await this.app.fileManager.processFrontMatter(rootFile, (fm) => {
        changedFields.forEach(([type, url]) => {
          fm[type === "UT" ? "ut" : type] = url;
        });
      });
    }

    const effectiveFrontmatter = { ...frontmatter };
    changedFields.forEach(([type, url]) => {
      effectiveFrontmatter[type === "UT" ? "ut" : type] = url;
    });
    const downloadResult = await this.downloadTicketCltDocuments(normalized, effectiveFrontmatter);
    warnings.push(...downloadResult.warnings);

    if (options.notify || options.initial) {
      const candidateCount = Object.values(candidateGroups).reduce((sum, list) => sum + list.length, 0);
      const result = changedFields.length
        ? `${changedFields.map(([type]) => type).join("·")} 링크 반영 완료`
        : downloadResult.linkedBs?.changed
          ? "BS 로컬 파일 연결 완료"
          : candidateCount ? "선택한 새 링크가 없습니다." : "검색된 문서 링크가 없습니다.";
      const downloaded = downloadResult.downloaded.length
        ? `\n${downloadResult.downloaded.join("·")} 파일 다운로드 완료`
        : "";
      new Notice(`${normalized} 문서 검색 · ${result}${downloaded}${warnings.length ? `\n${warnings.join("\n")}` : ""}`, 10000);
    }
    return { changedFields, candidateGroups, warnings, downloaded: downloadResult.downloaded };
  }

  async disconnectGoogleDrive() {
    const token = this.getSecret(GOOGLE_REFRESH_TOKEN_KEY) || this.getSecret(GOOGLE_ACCESS_TOKEN_KEY);
    if (token) {
      try {
        await requestUrl({
          url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          throw: false
        });
      } catch (_) { /* local cleanup still proceeds */ }
    }
    this.deleteSecret(GOOGLE_ACCESS_TOKEN_KEY);
    this.deleteSecret(GOOGLE_REFRESH_TOKEN_KEY);
    this.settings.googleTokenExpiresAt = 0;
    this.settings.googleConnectedAt = "";
    this.settings.googleAccountEmail = "";
    this.settings.googleDriveContentAccess = false;
    this.settings.googleGrantedScopes = "";
    await this.savePluginData();
    new Notice("Google Drive 연결을 해제했습니다.");
  }

  async apiGet(path, query = {}) {
    const token = await this.validAccessToken();
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    });
    const url = `${cleanInstanceUrl(this.settings.instanceUrl)}${path}${params.size ? `?${params}` : ""}`;
    const response = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      throw: false
    });
    if (response.status === 401) {
      this.settings.tokenExpiresAt = 0;
      await this.savePluginData();
      throw new Error("ServiceNow 인증이 만료되었습니다. 다시 연결하세요.");
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = response.json?.error?.message || response.json?.error?.detail || response.text || `HTTP ${response.status}`;
      throw new Error(String(detail).slice(0, 400));
    }
    return response.json;
  }

  async attachmentImageDataUrl(entry) {
    const attachmentId = String(entry?.attachmentId || "").trim();
    if (!attachmentId) throw new Error("첨부파일 ID가 없습니다.");
    if (Number(entry.sizeBytes || 0) > 15 * 1024 * 1024) throw new Error("15MB를 초과해 미리보기를 생략했습니다.");
    if (this.attachmentImageCache.has(attachmentId)) return this.attachmentImageCache.get(attachmentId);
    const loading = (async () => {
      const token = await this.validAccessToken();
      const response = await requestUrl({
        url: `${cleanInstanceUrl(this.settings.instanceUrl)}/api/now/attachment/${encodeURIComponent(attachmentId)}/file`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: entry.contentType || "image/*" },
        throw: false
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(response.text || `HTTP ${response.status}`);
      }
      const responseType = response.headers?.["content-type"] || response.headers?.["Content-Type"] || "";
      const contentType = String(entry.contentType || responseType || "image/png").split(";")[0];
      if (!contentType.toLowerCase().startsWith("image/")) throw new Error("이미지 형식이 아닙니다.");
      return `data:${contentType};base64,${Buffer.from(response.arrayBuffer).toString("base64")}`;
    })();
    this.attachmentImageCache.set(attachmentId, loading);
    try {
      return await loading;
    } catch (error) {
      this.attachmentImageCache.delete(attachmentId);
      throw error;
    }
  }

  async persistTicketAttachmentImages(ticketId, ticket) {
    const images = (ticket?.entries || []).filter((entry) =>
      entry.type === "Attachment"
      && isImageAttachment(entry.content, entry.contentType)
      && entry.attachmentId
      && Number(entry.sizeBytes || 0) <= 15 * 1024 * 1024
    );
    if (!images.length) return 0;
    const folder = normalizePath(`${this.ticketAssetsFolder(ticketId)}/ServiceNow`);
    await this.ensureFolder(folder);
    let saved = 0;
    for (const entry of images) {
      const original = String(entry.content || "attachment-image")
        .replace(/[\\/:*?"<>|#[\]^]/g, "_")
        .trim() || "attachment-image";
      const id = String(entry.attachmentId).slice(0, 12);
      const fileName = `SN-${id}-${original}`;
      const path = normalizePath(`${folder}/${fileName}`);
      entry.localPath = path;
      if (this.app.vault.getAbstractFileByPath(path)) continue;
      try {
        const dataUrl = await this.attachmentImageDataUrl(entry);
        const encoded = String(dataUrl).split(",", 2)[1] || "";
        const bytes = Buffer.from(encoded, "base64");
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await this.app.vault.createBinary(path, arrayBuffer);
        saved += 1;
      } catch (error) {
        ticket.warnings = [...(ticket.warnings || []), `이미지 로컬 저장 제외 (${original}): ${error.message || error}`];
      }
    }
    return saved;
  }

  async ensureAttachmentVideoFile(ticketId, entry) {
    if (!isVideoAttachment(entry?.content, entry?.contentType)) throw new Error("영상 형식이 아닙니다.");
    const size = Number(entry?.sizeBytes || 0);
    if (size > 100 * 1024 * 1024) throw new Error("100MB를 초과해 자동 재생 준비를 생략했습니다.");
    const attachmentId = serviceNowAttachmentId(entry);
    if (!attachmentId) throw new Error("첨부파일 ID가 없습니다.");
    const folder = normalizePath(`${this.ticketAssetsFolder(ticketId)}/ServiceNow`);
    await this.ensureFolder(folder);
    const original = String(entry.content || "attachment-video")
      .replace(/[\\/:*?"<>|#[\]^]/g, "_")
      .trim() || "attachment-video.mp4";
    const path = normalizePath(`${folder}/SN-${attachmentId.slice(0, 12)}-${original}`);
    entry.localPath = path;
    if (this.app.vault.getAbstractFileByPath(path)) return path;
    const token = await this.validAccessToken();
    const response = await requestUrl({
      url: `${cleanInstanceUrl(this.settings.instanceUrl)}/api/now/attachment/${encodeURIComponent(attachmentId)}/file`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: entry.contentType || "video/*" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) throw new Error(response.text || `HTTP ${response.status}`);
    const responseType = response.headers?.["content-type"] || response.headers?.["Content-Type"] || "";
    const contentType = String(entry.contentType || responseType).split(";")[0].toLowerCase();
    if (!contentType.startsWith("video/") && !isVideoAttachment(original, contentType)) {
      throw new Error("ServiceNow가 영상 형식으로 반환하지 않았습니다.");
    }
    const bytes = Buffer.from(response.arrayBuffer);
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("다운로드된 영상이 100MB를 초과합니다.");
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await this.app.vault.createBinary(path, arrayBuffer);
    await this.savePluginData();
    return path;
  }

  async persistTicketAttachmentVideos(ticketId, ticket) {
    const videos = (ticket?.entries || []).filter((entry) =>
      entry.type === "Attachment"
      && isVideoAttachment(entry.content, entry.contentType)
      && serviceNowAttachmentId(entry)
      && Number(entry.sizeBytes || 0) <= 100 * 1024 * 1024
    );
    let saved = 0;
    for (const entry of videos) {
      const existed = entry.localPath && this.app.vault.getAbstractFileByPath(entry.localPath);
      try {
        await this.ensureAttachmentVideoFile(ticketId, entry);
        if (!existed) saved += 1;
      } catch (error) {
        ticket.warnings = [...(ticket.warnings || []), `영상 로컬 저장 제외 (${entry.content || "첨부 영상"}): ${error.message || error}`];
      }
    }
    return saved;
  }

  async fetchTicket(ticketId) {
    const table = this.serviceNowTableForTicket(ticketId);
    if (!table) throw new Error("지원하지 않는 티켓 번호입니다.");
    const lookup = await this.apiGet(`/api/now/table/${table}`, {
      sysparm_query: `number=${ticketId}`,
      sysparm_display_value: "all",
      sysparm_limit: 1
    });
    const record = lookup.result?.[0];
    if (!record?.sys_id) throw new Error(`${ticketId} 티켓을 찾을 수 없습니다.`);
    const sysId = rawFieldValue(record.sys_id);

    const detailResponse = await this.apiGet(`/api/now/table/${table}/${sysId}`, {
      sysparm_fields: "number,short_description,description,work_notes,state,assignment_group,assigned_to,sys_updated_on",
      sysparm_display_value: "all"
    });
    const detail = detailResponse.result || {};
    const metadata = extractTicketMetadata(record);

    const warnings = [];
    let attachmentResponse = { result: [] };
    try {
      attachmentResponse = await this.apiGet("/api/now/table/sys_attachment", {
        sysparm_query: `table_name=${table}^table_sys_id=${sysId}`,
        sysparm_fields: "sys_id,file_name,content_type,size_bytes,sys_created_on,sys_created_by",
        sysparm_limit: 200
      });
    } catch (error) {
      warnings.push(`첨부파일 이력 제외: ${error.message}`);
    }
    const attachments = (attachmentResponse.result || []).map((file) => {
      const attachmentId = fieldValue(file.sys_id);
      return {
        id: `attachment-${attachmentId || hashId(JSON.stringify(file))}`,
        time: utcServiceNowToKst(fieldValue(file.sys_created_on)),
        type: "Attachment",
        author: fieldValue(file.sys_created_by),
        content: fieldValue(file.file_name) || "첨부파일",
        attachmentId,
        contentType: fieldValue(file.content_type),
        sizeBytes: Number(rawFieldValue(file.size_bytes) || 0),
        priority: 3,
        url: `${cleanInstanceUrl(this.settings.instanceUrl)}/sys_attachment.do?sys_id=${encodeURIComponent(attachmentId)}&view=true`
      };
    });

    let workNotes = parseWorkNotes(fieldValue(detail.work_notes));
    if (!workNotes.length) {
      try {
        const journalResponse = await this.apiGet("/api/now/table/sys_journal_field", {
          sysparm_query: `element_id=${sysId}^element=work_notes^ORDERBYDESCsys_created_on`,
          sysparm_fields: "sys_id,sys_created_on,sys_created_by,value,element",
          sysparm_limit: 1000,
          sysparm_display_value: "all"
        });
        workNotes = buildJournalWorkNotes(journalResponse.result || []);
      } catch (error) {
        warnings.push(`Work Notes history excluded: ${error.message}`);
      }
    }
    return {
      ticketId,
      table,
      sysId,
      shortDescription: fieldValue(detail.short_description),
      description: fieldValue(detail.description),
      state: fieldValue(detail.state),
      ...metadata,
      assignmentGroup: metadata.assignmentGroup || fieldValue(detail.assignment_group),
      assignedTo: metadata.assignedTo || fieldValue(detail.assigned_to),
      serviceNowUpdatedAt: metadata.serviceNowUpdated || fieldValue(detail.sys_updated_on),
      serviceNowUrl: `${cleanInstanceUrl(this.settings.instanceUrl)}/${table}.do?sys_id=${encodeURIComponent(sysId)}`,
      entries: mergeEntries(workNotes, attachments),
      lastSyncedAt: localIsoDateTime(),
      lastAttemptAt: localIsoDateTime(),
      lastError: "",
      warnings
    };
  }

  async fetchTicketMetadata(ticketId) {
    const table = this.serviceNowTableForTicket(ticketId);
    if (!table) throw new Error("지원하지 않는 티켓 번호입니다.");
    const response = await this.apiGet(`/api/now/table/${table}`, {
      sysparm_query: `number=${ticketId}`,
      sysparm_display_value: "all",
      sysparm_limit: 1
    });
    const record = response.result?.[0];
    if (!record) throw new Error(`${ticketId} 티켓을 찾을 수 없습니다.`);
    const sysId = rawFieldValue(record.sys_id).trim();
    const state = fieldValue(record.state).trim();
    if (!state) throw new Error(`${ticketId} 상태를 확인할 수 없습니다.`);
    return { state, sysId, table, ...extractTicketMetadata(record) };
  }

  async fetchTicketStatus(ticketId) {
    return (await this.fetchTicketMetadata(ticketId)).state;
  }

  async applyTicketState(ticketId, state, rootFile = null) {
    const normalized = normalizeTicketId(ticketId);
    const nextState = String(state || "").trim();
    const file = rootFile instanceof TFile ? rootFile : this.rootTicketFile(normalized);
    if (!file || !nextState) return { ticketId: normalized, state: nextState, skipped: true };
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const previous = String(fm.status || "");
    const changed = previous !== nextState;
    if (changed) {
      await this.applyExternalStatus(file, nextState);
    }
    return { ticketId: normalized, state: nextState, previous, changed };
  }

  async updateTicketMetadata(ticketId, metadata, rootFile = null) {
    const normalized = normalizeTicketId(ticketId);
    const file = rootFile instanceof TFile ? rootFile : this.rootTicketFile(normalized);
    if (!file || !metadata) return false;
    const values = {
      purpose: metadata.purpose,
      short_description: metadata.shortDescription,
      service_now_priority: metadata.serviceNowPriority,
      ticket_creator: metadata.ticketCreator,
      ticket_requester: metadata.ticketRequester,
      service_now_created: metadata.serviceNowCreated,
      assignment_group: metadata.assignmentGroup,
      assigned_person: metadata.assignedTo,
      service_now_category: metadata.serviceNowCategory,
      service_now_updated: metadata.serviceNowUpdated || metadata.serviceNowUpdatedAt,
      estimated_qa_completion_date: metadata.estimatedQaCompletionDate,
      target_qa_completion_date: metadata.targetQaCompletionDate,
      actual_release_date: metadata.actualReleaseDate,
      "배포일": metadata.deploymentFinish,
      ui_interface_id: metadata.uiInterfaceIds
    };
    let changed = false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const [key, value] of Object.entries(values)) {
        const next = String(value || "").trim();
        if (String(frontmatter[key] || "").trim() === next) continue;
        frontmatter[key] = next;
        changed = true;
      }
    });
    return changed;
  }

  async syncTicketStatus(ticketId, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized) throw new Error("유효한 티켓 번호가 아닙니다.");
    if (this.statusSyncing.has(normalized)) return { ticketId: normalized, skipped: true };
    const file = this.rootTicketFile(normalized);
    if (!file) throw new Error(`${normalized} 원본 티켓 노트를 찾을 수 없습니다.`);

    this.statusSyncing.add(normalized);
    try {
      const metadata = await this.fetchTicketMetadata(normalized);
      const metadataChanged = await this.updateTicketMetadata(normalized, metadata, file);
      const state = metadata.state;
      const result = await this.applyTicketState(normalized, state, file);
      result.metadataChanged = metadataChanged;
      const stored = this.data.tickets[normalized] || { ticketId: normalized, entries: [] };
      stored.state = state;
      stored.entries = (stored.entries || []).filter((entry) => entry.type !== "Field Change");
      stored.warnings = (stored.warnings || []).filter((warning) =>
        !/(?:Field Changes|History Set|Activity Stream)/i.test(String(warning))
      );
      delete stored.stateHistory;
      delete stored.historyDiagnostics;
      delete stored.lastHistorySyncedAt;
      this.data.tickets[normalized] = stored;
      await this.savePluginData();
      this.refreshViews(normalized);
      const { previous, changed } = result;
      if (options.notify) {
        new Notice(changed
          ? `${normalized} 상태 갱신: ${previous || "미확인"} → ${state}`
          : `${normalized} 상태는 ${state}로 동일합니다.${metadataChanged ? " 기본정보는 최신 값으로 갱신했습니다." : ""}`, 7000);
      }
      return result;
    } catch (error) {
      if (options.notify) new Notice(`${normalized} 상태 갱신 실패: ${error.message || error}`, 9000);
      throw error;
    } finally {
      this.statusSyncing.delete(normalized);
    }
  }

  async syncAllTicketStatuses(options = {}) {
    const files = this.rootTicketFiles();
    const results = [];
    let failed = 0;
    for (const file of files) {
      const ticketId = this.rootTicketIdFromFile(file);
      try {
        results.push(await this.syncTicketStatus(ticketId));
      } catch (error) {
        failed += 1;
        console.error(`[ServiceNow Manage] ${ticketId} 상태 갱신 실패`, error);
      }
    }
    const changed = results.filter((result) => result?.changed).length;
    if (options.notify) {
      new Notice(`ServiceNow 상태 전체 갱신 완료 · 변경 ${changed}건 · 동일 ${results.length - changed}건${failed ? ` · 실패 ${failed}건` : ""}`, 9000);
    }
    return { total: files.length, changed, unchanged: results.length - changed, failed };
  }

  async syncAllTickets(options = {}) {
    const files = this.rootTicketFiles();
    let completed = 0;
    let failed = 0;
    for (const file of files) {
      const ticketId = this.rootTicketIdFromFile(file);
      try {
        const fresh = await this.syncTicket(ticketId);
        if (fresh) completed += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        console.error(`[ServiceNow Manage] ${ticketId} 전체 갱신 실패`, error);
      }
    }
    if (options.notify) {
      new Notice(`ServiceNow 전체 갱신 완료 · 상태·기본정보·워킹노트 ${completed}건${failed ? ` · 실패 ${failed}건` : ""}`, 9000);
    }
    return { total: files.length, completed, failed };
  }

  async syncTicket(ticketId, options = {}) {
    const normalized = normalizeTicketId(ticketId);
    if (!normalized || this.syncing.has(normalized)) return;
    this.syncing.add(normalized);
    const previous = this.data.tickets[normalized] || { ticketId: normalized, entries: [] };
    previous.lastAttemptAt = localIsoDateTime();
    previous.lastError = "";
    this.data.tickets[normalized] = previous;
    this.refreshViews(normalized);
    try {
      const fresh = await this.fetchTicket(normalized);
      const workNotesLookupFailed = (fresh.warnings || []).some((warning) => warning.startsWith("Work Notes history excluded:"));
      const freshWorkNotes = (fresh.entries || []).filter((entry) => entry.type === "Work Note");
      const previousWorkNotes = (previous.entries || []).filter((entry) => entry.type === "Work Note");
      if (workNotesLookupFailed && !freshWorkNotes.length && previousWorkNotes.length) {
        fresh.entries = mergeEntries(
          previousWorkNotes,
          (fresh.entries || []).filter((entry) => entry.type !== "Work Note")
        );
        fresh.warnings.push("ServiceNow Work Notes 조회 실패로 기존 대화 내역을 보존했습니다.");
      }
      const oldById = new Map((previous.entries || []).map((entry) => [entry.id, entry]));
      fresh.entries = fresh.entries.map((entry) => ({
        ...entry,
        translations: oldById.get(entry.id)?.translations || entry.translations || {}
      }));
      fresh.translations = {};
      for (const field of ["shortDescription", "description"]) {
        if (fresh[field] === previous[field] && previous.translations?.[field]) {
          fresh.translations[field] = previous.translations[field];
        }
      }
      fresh.documentSearchInitialized = Boolean(previous.documentSearchInitialized);
      await this.persistTicketAttachmentImages(normalized, fresh);
      await this.persistTicketAttachmentVideos(normalized, fresh);
      await this.updateTicketMetadata(normalized, fresh, options.rootFile);
      await this.applyTicketState(normalized, fresh.state, options.rootFile);
      await this.updateTicketServiceNowLink(normalized, fresh.serviceNowUrl, options.rootFile);
      this.data.tickets[normalized] = fresh;
      const localBs = this.findLocalTicketDocument(normalized, "BS");
      if (localBs) await this.linkLocalBsDocument(normalized, localBs);
      await this.updateWorkNotesFrontMatter(normalized, "Success", fresh.lastSyncedAt);
      await this.savePluginData();
      this.refreshViews(normalized);
      if (options.notify) {
        const warningText = fresh.warnings?.length ? `\n${fresh.warnings.join("\n")}` : "";
        new Notice(`${normalized} 워킹노트 갱신 완료 · ${fresh.entries.length}건${warningText}`, 8000);
      }
      return fresh;
    } catch (error) {
      previous.lastError = error.message || String(error);
      previous.lastAttemptAt = localIsoDateTime();
      this.data.tickets[normalized] = previous;
      await this.updateWorkNotesFrontMatter(normalized, "Failed", "");
      await this.savePluginData();
      this.refreshViews(normalized);
      if (options.notify) new Notice(`${normalized} 갱신 실패: ${previous.lastError}`, 9000);
      return null;
    } finally {
      this.syncing.delete(normalized);
    }
  }

  async updateWorkNotesFrontMatter(ticketId, status, lastSynced) {
    const files = this.app.vault.getMarkdownFiles();
    const target = files.find((file) => {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return normalizeTicketId(fm.ticket) === ticketId && String(fm.category || "") === "Work Notes";
    });
    if (!target) return;
    await this.app.fileManager.processFrontMatter(target, (fm) => {
      fm.sync_status = status;
      if (lastSynced) fm.last_synced = lastSynced;
    });
  }

  async updateTicketServiceNowLink(ticketId, serviceNowUrl, rootFile = null) {
    const normalized = normalizeTicketId(ticketId);
    const url = String(serviceNowUrl || "").trim();
    const file = rootFile instanceof TFile ? rootFile : this.rootTicketFile(normalized);
    if (!file || !url) return false;
    let changed = false;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (String(frontmatter["서비스나우"] || "").trim()) return;
      frontmatter["서비스나우"] = url;
      changed = true;
    });
    return changed;
  }

  openTicketInBrowser(ticketId) {
    const ticket = this.data.tickets[ticketId];
    const url = ticket?.serviceNowUrl || cleanInstanceUrl(this.settings.instanceUrl);
    shell.openExternal(url);
  }

  getTranslateApi() {
    return this.app.plugins?.plugins?.translate?.api || null;
  }

  async ensureTranslateApi() {
    const translatePlugin = this.app.plugins?.plugins?.translate;
    const api = translatePlugin?.api;
    if (!api?.translate) return { api: null, reason: "missing" };

    try {
      if (!translatePlugin.translator && translatePlugin.reactivity?.getTranslationService) {
        const serviceId = api.settings?.translation_service;
        if (serviceId) {
          translatePlugin.translator = await translatePlugin.reactivity.getTranslationService(serviceId);
        }
      }

      if (translatePlugin.translator && !translatePlugin.translator.valid
        && typeof translatePlugin.translator.validate === "function") {
        const validation = await translatePlugin.translator.validate();
        if (!validation?.valid) {
          return {
            api,
            reason: "not-ready",
            message: validation?.message || "번역 서비스 검증에 실패했습니다."
          };
        }
      }
    } catch (error) {
      return { api, reason: "not-ready", message: error.message };
    }

    return api.canTranslate
      ? { api, reason: null }
      : { api, reason: "not-ready", message: "Translate 설정에서 번역 서비스를 선택하고 검증해 주세요." };
  }

  async translateTextForExport(content, target = "en") {
    const source = String(content || "").trim();
    if (!source) return "";
    const translate = await this.ensureTranslateApi();
    if (!translate.api || translate.reason) {
      const message = translate.reason === "missing"
        ? "Translate 플러그인이 설치되어 있지 않거나 비활성화되어 있습니다."
        : `Translate 플러그인의 번역 서비스가 준비되지 않았습니다. ${translate.message || ""}`;
      throw new Error(message.trim());
    }
    const { masked, urls } = protectUrls(source);
    const output = await translate.api.translate(masked, "auto", target);
    if (output?.status_code !== 200 || !output.translation) {
      throw new Error(output?.message || `번역 실패 (status ${output?.status_code || "unknown"})`);
    }
    return restoreUrls(output.translation, urls);
  }

  async translateTicket(ticketId, language, options = {}) {
    const target = language === "ko" ? "ko" : language === "vi" ? "vi" : "";
    if (!target || this.translating.has(`${ticketId}:${target}`)) return;
    const translate = await this.ensureTranslateApi();
    const api = translate.api;
    if (!api || translate.reason) {
      if (options.notify) {
        const message = translate.reason === "missing"
          ? "Translate 플러그인이 설치되어 있지 않거나 비활성화되어 있습니다."
          : `Translate 플러그인은 설치되어 있지만 번역 서비스가 준비되지 않았습니다. ${translate.message || ""}`;
        new Notice(message.trim(), 9000);
      }
      return;
    }
    const ticket = this.data.tickets[ticketId];
    if (!ticket) return;
    const key = `${ticketId}:${target}`;
    this.translating.add(key);
    let completed = 0;
    let consecutiveFailures = 0;
    let stoppedEarly = false;
    const failures = [];
    try {
      ticket.translations = ticket.translations || {};
      const summaryFields = [
        ["shortDescription", "Short description"],
        ["description", "Description"]
      ];
      for (const [field, label] of summaryFields) {
        const content = ticket[field];
        if (!content) continue;
        const existing = ticket.translations[field]?.[target];
        if (existing) {
          const repaired = restoreUrls(existing, protectUrls(content).urls);
          if (repaired !== existing) {
            ticket.translations[field][target] = repaired;
            completed++;
          }
          continue;
        }
        const { masked, urls } = protectUrls(content);
        try {
          const output = await api.translate(masked, "auto", target);
          if (output?.status_code !== 200 || !output.translation) {
            throw new Error(output?.message || `status ${output?.status_code || "unknown"}`);
          }
          ticket.translations[field] = ticket.translations[field] || {};
          ticket.translations[field][target] = restoreUrls(output.translation, urls);
          completed++;
          consecutiveFailures = 0;
        } catch (error) {
          failures.push(`${label}: ${error.message}`);
          consecutiveFailures++;
          if (!api.canTranslate || consecutiveFailures >= 3) {
            stoppedEarly = true;
            break;
          }
        }
      }
      if (!stoppedEarly) {
        for (const entry of ticket.entries || []) {
          if (entry.type === "Attachment" || !entry.content) continue;
          const existing = entry.translations?.[target];
          if (existing) {
            const repaired = restoreUrls(existing, protectUrls(entry.content).urls);
            if (repaired !== existing) {
              entry.translations[target] = repaired;
              completed++;
            }
            continue;
          }
          const { masked, urls } = protectUrls(entry.content);
          try {
            const output = await api.translate(masked, "auto", target);
            if (output?.status_code !== 200 || !output.translation) {
              throw new Error(output?.message || `status ${output?.status_code || "unknown"}`);
            }
            entry.translations = entry.translations || {};
            entry.translations[target] = restoreUrls(output.translation, urls);
            completed++;
            consecutiveFailures = 0;
            if (completed % 10 === 0) {
              await this.savePluginData();
              this.refreshViews(ticketId);
            }
          } catch (error) {
            failures.push(`${entry.time}: ${error.message}`);
            consecutiveFailures++;
            if (!api.canTranslate || consecutiveFailures >= 3) {
              stoppedEarly = true;
              break;
            }
          }
        }
      }
      await this.savePluginData();
      this.refreshViews(ticketId);
      if (options.notify) {
        const label = target === "ko" ? "한국어" : "베트남어";
        const firstError = failures[0]?.replace(/^.*?:\s*/, "").slice(0, 180);
        const detail = firstError ? ` · ${firstError}` : "";
        new Notice(
          `${label} 번역 완료 · ${completed}건${failures.length ? ` · 실패 ${failures.length}건` : ""}${stoppedEarly ? " · 반복 실패로 중단" : ""}${detail}`,
          10000
        );
      }
    } finally {
      this.translating.delete(key);
    }
  }

  async runCatchUpSync() {
    if (!this.settings.autoSync) return;
    const today = localIsoDateTime().slice(0, 10);
    const ids = Object.keys(this.data.tickets).filter((id) => {
      const last = this.data.tickets[id]?.lastSyncedAt || "";
      return last.slice(0, 10) < today;
    });
    for (const id of ids) await this.syncTicket(id);
  }

  async syncUninitializedTickets() {
    const ids = this.rootTicketFiles()
      .map((file) => this.rootTicketIdFromFile(file))
      .filter((id) => id && !this.data.tickets[id]?.lastSyncedAt);
    for (const id of ids) await this.syncTicket(id);
  }

  async runDailyStatusSyncIfDue() {
    if (!this.settings.autoStatusSync || this.dailyStatusSyncing) return;
    const now = new Date();
    const today = localIsoDate(now);
    if (this.settings.lastStatusSyncDate === today) return;
    const configuredTime = /^\d{2}:\d{2}$/.test(this.settings.statusSyncTime || "")
      ? this.settings.statusSyncTime
      : "09:00";
    const currentTime = localIsoDateTime(now).slice(11, 16);
    if (currentTime < configuredTime) return;
    this.dailyStatusSyncing = true;
    try {
      const result = await this.syncAllTickets();
      this.settings.lastStatusSyncDate = today;
      await this.savePluginData();
      new Notice(`일일 ServiceNow 전체 갱신 완료 · 상태·기본정보·워킹노트 ${result.completed}건${result.failed ? ` · 실패 ${result.failed}건` : ""}`, 8000);
    } finally {
      this.dailyStatusSyncing = false;
    }
  }

  async automationTick() {
    await this.runDailyStatusSyncIfDue();
    if (!this.settings.autoSync || !this.settings.syncAtTopOfHour) return;
    const now = new Date();
    if (now.getMinutes() !== 0) return;
    const marker = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (marker === this.lastAutomationHour) return;
    this.lastAutomationHour = marker;
    for (const id of Object.keys(this.data.tickets)) await this.syncTicket(id);
  }
}

module.exports = CltServiceNowWorkNotes;
module.exports.__test = {
  addCalendarDays,
  addWorkingDays,
  appendEntryToMarkdownSection,
  cleanBearerToken,
  defaultTicketTemplate,
  defaultWorkNotesTemplate,
  defaultAiPromptTemplate,
  bundledAnalysisTemplate,
  upgradeDashboardRuntime,
  upgradeDashboardPopupFieldGrid,
  upgradeDashboardTodoCreation,
  upgradeDashboardControlVisibility,
  upgradeDashboardTodoDetails,
  upgradeDashboardTodoSummaryColumn,
  upgradeDashboardSharedTodoModal,
  upgradeDashboardFieldOrdering,
  upgradeDashboardTodoPagination,
  extractDescriptionLinks,
  extractTicketMetadata,
  selectAiPromptTemplate,
  replacePromptField,
  replacePromptWorkingNotes,
  buildAiEnvironmentInstructions,
  googleDriveFileId,
  googleDownloadFormat,
  safeFileName,
  documentTypeFromFileName,
  isStandardBsFileName,
  standardBsBaseName,
  wikiLinkTarget,
  isLocalBsWikiLink,
  adaptPromptToAvailableDocuments,
  fieldValue,
  fillTemplate,
  ensureSectionActionBlock,
  mergeEntries,
  normalizeTicketId,
  parseWikiLink,
  buildMeetingNoteMarkdown,
  buildMeetingAnalysisPrompt,
  parseWorkNotes,
  protectUrls,
  restoreUrls,
  serviceNowField,
  tableForTicket,
  utcServiceNowToKst
};
