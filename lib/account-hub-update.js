/** Account Hub 插件的检查更新与安装逻辑。 */
import { join } from 'node:path';
const NOOP_ACCOUNT_HUB_UPDATE_PROGRESS = () => { };
const RELEASES_LATEST_URL = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/releases/latest';
const COMMIT_BY_REF_URL_PREFIX = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits/';
const COMMIT_COMPARE_URL_PREFIX = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/compare/';
const COMMITS_URL = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits';
const TARBALL_URL_PREFIX = 'https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/';
const ACCOUNT_HUB_GITHUB_PIN = 'github:gurio-wine/dsh-account-hub';
export const ACCOUNT_HUB_UPDATE_TIMEOUT_MS = 120_000;
/**
 * 从 pnpm-lock.yaml 的 dependencies 下定位 dsh-account-hub tarball，并提取完整 commit SHA。
 * 对外保持既有严格行为；半卸载状态的检查与应用使用内部 nullable 查找器。
 */
export function extractAccountHubSha(lockfile) {
    const sha = findAccountHubSha(lockfile);
    if (sha !== null)
        return sha;
    if (!/^[ \t]*dependencies:\s*(?:#.*)?$/m.test(lockfile)) {
        throw new Error('pnpm-lock.yaml 格式无效：找不到 dependencies 段');
    }
    throw new Error('pnpm-lock.yaml dependencies 段中找不到 dsh-account-hub');
}
/** 找不到目标依赖时返回 null；目标条目存在但格式错误仍抛出原有错误。 */
function findAccountHubSha(lockfile) {
    const lines = lockfile.split(/\r?\n/);
    for (let sectionIndex = 0; sectionIndex < lines.length; sectionIndex += 1) {
        const sectionMatch = lines[sectionIndex].match(/^([ \t]*)dependencies:\s*(?:#.*)?$/);
        if (sectionMatch === null)
            continue;
        const sectionIndent = sectionMatch[1].length;
        let sectionEnd = sectionIndex + 1;
        while (sectionEnd < lines.length) {
            const line = lines[sectionEnd];
            if (line.trim() === '') {
                sectionEnd += 1;
                continue;
            }
            if (leadingWhitespaceLength(line) <= sectionIndent)
                break;
            sectionEnd += 1;
        }
        for (let packageIndex = sectionIndex + 1; packageIndex < sectionEnd; packageIndex += 1) {
            const packageMatch = lines[packageIndex].match(/^([ \t]*)dsh-account-hub:\s*(.*)$/);
            if (packageMatch === null || packageMatch[1].length <= sectionIndent)
                continue;
            const packageIndent = packageMatch[1].length;
            let packageEnd = packageIndex + 1;
            while (packageEnd < sectionEnd) {
                const line = lines[packageEnd];
                if (line.trim() !== '' && leadingWhitespaceLength(line) <= packageIndent)
                    break;
                packageEnd += 1;
            }
            const packageBlock = [packageMatch[2], ...lines.slice(packageIndex + 1, packageEnd)].join('\n');
            const shaMatch = packageBlock.match(/https:\/\/codeload\.github\.com\/gurio-wine\/dsh-account-hub\/tar\.gz\/([0-9a-f]{40})(?=$|[\s"'#?&])/i);
            if (shaMatch === null) {
                throw new Error('pnpm-lock.yaml 中 dsh-account-hub 的 tarball URL 格式无效，无法提取 40 位 SHA');
            }
            return shaMatch[1].toLowerCase();
        }
        sectionIndex = sectionEnd - 1;
    }
    return null;
}
/** 查询最新 release 元数据；beta 可在没有 release 时退回固定前缀。 */
async function fetchLatestReleaseInfo(deps, allowMissing = false) {
    try {
        const response = await deps.fetcher(RELEASES_LATEST_URL, {
            headers: { accept: 'application/vnd.github+json' },
        });
        if (!response.ok) {
            if (response.status === 404 && allowMissing)
                return null;
            if (response.status === 404) {
                throw new Error('尚无 GitHub release，无法检查更新（发首个 release 后可检查）');
            }
            throw new Error(`GitHub Releases API 返回 HTTP ${response.status}`);
        }
        const body = await response.json();
        if (typeof body !== 'object' || body === null)
            throw new Error('GitHub Releases API 响应不是对象');
        const release = body;
        if (typeof release.tag_name !== 'string' || release.tag_name.trim().length === 0) {
            throw new Error('GitHub Release 响应缺少有效的 tag_name');
        }
        return {
            tag: release.tag_name,
            title: typeof release.name === 'string' && release.name.length > 0 ? release.name : release.tag_name,
            body: typeof release.body === 'string' ? release.body : '',
        };
    }
    catch (error) {
        throw new Error(`无法获取最新版本：${errorMessage(error)}`);
    }
}
/** 使用 commits/{ref} 直接解析分支或 tag 对应的 commit 本体。 */
async function fetchCommitByRef(deps, ref) {
    try {
        const response = await deps.fetcher(`${COMMIT_BY_REF_URL_PREFIX}${encodeURIComponent(ref)}`, {
            headers: { accept: 'application/vnd.github+json' },
        });
        if (!response.ok)
            throw new Error(`GitHub commits API 返回 HTTP ${response.status}（ref ${ref}）`);
        const body = await response.json();
        if (typeof body !== 'object' || body === null)
            throw new Error('GitHub commits API 响应不是对象');
        const commit = body;
        if (typeof commit.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(commit.sha)) {
            throw new Error('GitHub commits API 响应缺少有效的 40 位 SHA');
        }
        return {
            sha: commit.sha.toLowerCase(),
            message: typeof commit.commit?.message === 'string' ? commit.commit.message : '',
        };
    }
    catch (error) {
        throw new Error(`无法获取提交 ${ref}：${errorMessage(error)}`);
    }
}
/** 按 stable release 或 beta master HEAD 解析待安装版本。 */
async function fetchLatestVersion(deps, channel) {
    const release = await fetchLatestReleaseInfo(deps, channel === 'beta');
    if (channel === 'stable') {
        if (release === null)
            throw new Error('尚无 GitHub release，无法检查更新（发首个 release 后可检查）');
        const tagCommit = await fetchCommitByRef(deps, release.tag);
        return {
            sha: tagCommit.sha,
            tag: release.tag,
            title: release.title,
            release,
        };
    }
    const head = await fetchCommitByRef(deps, 'master');
    const tag = release?.tag ?? 'beta';
    const title = firstCommitLine(head.message) || tag;
    return { sha: head.sha, tag, title, release };
}
/** 将 GitHub compare 或 commits 响应中的提交标题格式化为最多 20 行。 */
async function fetchCommitChangelog(deps, url, source) {
    try {
        const response = await deps.fetcher(url, {
            headers: { accept: 'application/vnd.github+json' },
        });
        if (!response.ok)
            throw new Error(`GitHub ${source} API 返回 HTTP ${response.status}`);
        const body = await response.json();
        const commits = Array.isArray(body)
            ? body
            : typeof body === 'object' && body !== null && Array.isArray(body.commits)
                ? body.commits
                : null;
        if (commits === null)
            throw new Error(`GitHub ${source} API 响应缺少 commits 列表`);
        const lines = [];
        for (const item of commits.slice(0, 20)) {
            if (typeof item !== 'object' || item === null)
                continue;
            const commit = item;
            if (typeof commit.commit?.message !== 'string')
                continue;
            const title = firstCommitLine(commit.commit.message);
            if (title.length > 0)
                lines.push(`- ${title}`);
        }
        return lines.join('\n');
    }
    catch (error) {
        throw new Error(`无法获取更新日志：${errorMessage(error)}`);
    }
}
function firstCommitLine(message) {
    return message.split(/\r?\n/, 1)[0];
}
function compareCommitsUrl(base, head) {
    return `${COMMIT_COMPARE_URL_PREFIX}${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=20`;
}
function shortSha(sha, length = 8) {
    return sha.slice(0, length);
}
/** 查询当前安装 SHA 与所选更新轨道，并返回完整版本显示与日志字段。 */
export async function checkAccountHubUpdate(deps, channel = 'stable') {
    // 检查也要让位于进行中的应用：remove/add 两步之间磁盘是半套状态
    // （package.json 可能已没有依赖、lockfile 还没写入新 SHA），此刻读到
    // 什么都会把「未安装」误报给用户。拒绝并让客户端稍后重查。
    if (updateApplyInProgress)
        throw new Error(UPDATE_APPLY_IN_PROGRESS_ERROR);
    const lockfile = await deps.readFile(join(deps.profileRoot, 'pnpm-lock.yaml'));
    const currentSha = findAccountHubSha(lockfile) ?? '';
    const latest = await fetchLatestVersion(deps, channel);
    let changelog;
    let currentChangelog = '';
    if (channel === 'stable') {
        changelog = latest.release?.body ?? '';
        if (currentSha === latest.sha)
            currentChangelog = changelog;
    }
    else {
        changelog = currentSha === ''
            ? await fetchCommitChangelog(deps, `${COMMITS_URL}?per_page=20`, 'commits')
            : await fetchCommitChangelog(deps, compareCommitsUrl(currentSha, 'master'), 'compare');
        if (currentSha !== '') {
            const currentCommit = await fetchCommitByRef(deps, currentSha);
            const currentCommitTitle = firstCommitLine(currentCommit.message);
            const currentCommitLine = currentCommitTitle.length > 0 ? `- ${currentCommitTitle}` : '';
            if (latest.release !== null) {
                const releaseCommit = await fetchCommitByRef(deps, latest.release.tag);
                if (currentSha !== releaseCommit.sha) {
                    currentChangelog = await fetchCommitChangelog(deps, compareCommitsUrl(releaseCommit.sha, currentSha), 'compare');
                    if (currentCommitLine.length > 0 && !currentChangelog.split('\n').includes(currentCommitLine)) {
                        currentChangelog = [currentChangelog, currentCommitLine].filter((line) => line.length > 0).join('\n');
                    }
                }
                else {
                    currentChangelog = currentCommitLine;
                }
            }
            else {
                currentChangelog = currentCommitLine;
            }
        }
    }
    const currentVersion = channel === 'stable'
        ? currentSha === latest.sha
            ? latest.tag
            : currentSha === '' ? '' : shortSha(currentSha)
        : currentSha === '' ? '' : `${latest.tag}+${shortSha(currentSha, 7)}`;
    const latestVersion = channel === 'stable' ? latest.tag : `${latest.tag}+${shortSha(latest.sha, 7)}`;
    // lockfile 缺少目标依赖时，顺带只读扫描一次 node_modules，帮助用户识别上次中断留下的残留。
    const leftovers = currentSha === '' ? await detectAccountHubUpdateLeftovers(deps) : undefined;
    return {
        currentSha,
        latestSha: latest.sha,
        latestTag: latest.tag,
        hasUpdate: currentSha === '' || currentSha !== latest.sha,
        latestTitle: latest.title,
        currentVersion,
        latestVersion,
        changelog,
        currentChangelog,
        ...(leftovers === undefined ? {} : { leftovers }),
    };
}
const ACCOUNT_HUB_LEFTOVER_HINT = '上次更新中断留下的半装目录，重启宿主后手动删除或重试更新';
/**
 * 只读发现更新链中断后留下的目录；任何诊断失败都降级为空报告，不阻断更新主链路。
 * pnpm store 路径依赖 pnpm 配置，当前不猜测其位置，因此刻意跳过 store 扫描。
 */
export async function detectAccountHubUpdateLeftovers(deps) {
    if (deps.listDir === undefined)
        return { items: [] };
    const nodeModulesPath = join(deps.profileRoot, 'node_modules');
    let entries;
    try {
        entries = await deps.listDir(nodeModulesPath);
    }
    catch {
        return { items: [] };
    }
    const items = [];
    for (const entry of entries) {
        if (entry === 'dsh-account-hub') {
            try {
                await deps.readFile(join(nodeModulesPath, entry, 'package.json'));
            }
            catch {
                // listDir 已确认目录存在；缺 package.json 才是半装目录，属于可报告残留。
                items.push({
                    kind: 'incomplete-package',
                    path: join(nodeModulesPath, entry),
                    hint: ACCOUNT_HUB_LEFTOVER_HINT,
                });
            }
            continue;
        }
        if (entry.startsWith('dsh-account-hub_tmp_')) {
            items.push({
                kind: 'tmp-dir',
                path: join(nodeModulesPath, entry),
                hint: ACCOUNT_HUB_LEFTOVER_HINT,
            });
        }
    }
    return { items };
}
function findAllowBuildsSection(lines) {
    const sectionIndices = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (/^([ \t]*)allowBuilds:\s*(?:#.*)?$/.test(lines[index]))
            sectionIndices.push(index);
    }
    if (sectionIndices.length > 1)
        throw new Error('pnpm-workspace.yaml 中存在多个 allowBuilds 段');
    const sectionIndex = sectionIndices[0];
    if (sectionIndex === undefined)
        return undefined;
    const sectionIndent = leadingWhitespaceLength(lines[sectionIndex]);
    let sectionEnd = sectionIndex + 1;
    while (sectionEnd < lines.length) {
        const line = lines[sectionEnd];
        if (line.trim() !== '' && leadingWhitespaceLength(line) <= sectionIndent)
            break;
        sectionEnd += 1;
    }
    return { sectionIndex, sectionEnd, sectionIndent };
}
/**
 * 在 profile 根的 allowBuilds 下添加指定 tarball 的构建许可；同一条目重复调用不改文件。
 */
export function appendAccountHubAllowBuild(dependenciesFile, sha) {
    if (!/^[0-9a-f]{40}$/i.test(sha))
        throw new Error('待安装版本不是有效的 40 位 SHA');
    const normalizedSha = sha.toLowerCase();
    const tarballUrl = `${TARBALL_URL_PREFIX}${normalizedSha}`;
    const key = `dsh-account-hub@${tarballUrl}`;
    const newline = dependenciesFile.includes('\r\n') ? '\r\n' : '\n';
    const endsWithNewline = /\r?\n$/.test(dependenciesFile);
    const lines = dependenciesFile.split(/\r?\n/);
    if (endsWithNewline)
        lines.pop();
    const section = findAllowBuildsSection(lines);
    if (section !== undefined) {
        const { sectionIndex, sectionIndent } = section;
        let sectionEnd = section.sectionEnd;
        const entryPrefix = `${key}:`;
        for (let index = sectionIndex + 1; index < sectionEnd; index += 1) {
            const line = lines[index];
            const trimmed = line.trimStart();
            if (!trimmed.startsWith(entryPrefix))
                continue;
            const value = trimmed.slice(entryPrefix.length).trim();
            if (/^true(?:\s+#.*)?$/.test(value))
                return dependenciesFile;
            if (/^false(?:\s+#.*)?$/.test(value)) {
                const comment = value.match(/\s+#.*$/)?.[0] ?? '';
                lines[index] = `${line.slice(0, line.length - trimmed.length)}${entryPrefix} true${comment}`;
                return joinLines(lines, newline, endsWithNewline);
            }
        }
        const childIndent = lines
            .slice(sectionIndex + 1, sectionEnd)
            .find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
        const indent = childIndent === undefined
            ? ' '.repeat(sectionIndent + 2)
            : ' '.repeat(leadingWhitespaceLength(childIndent));
        lines.splice(sectionEnd, 0, `${indent}${key}: true`);
        return joinLines(lines, newline, endsWithNewline);
    }
    const content = joinLines(lines, newline, endsWithNewline);
    const separator = content.length > 0 && !content.endsWith(newline) ? newline : '';
    const appended = `${content}${separator}allowBuilds:${newline}  ${key}: true`;
    return `${appended}${endsWithNewline ? newline : ''}`;
}
/** 删除 Account Hub allowBuilds 段中除指定 SHA 外的旧 tarball 条目。 */
export function removeStaleAllowBuildEntries(workspaceFile, keepSha) {
    if (!/^[0-9a-f]{40}$/i.test(keepSha))
        throw new Error('保留版本不是有效的 40 位 SHA');
    const normalizedKeepSha = keepSha.toLowerCase();
    const newline = workspaceFile.includes('\r\n') ? '\r\n' : '\n';
    const endsWithNewline = /\r?\n$/.test(workspaceFile);
    const lines = workspaceFile.split(/\r?\n/);
    if (endsWithNewline)
        lines.pop();
    const section = findAllowBuildsSection(lines);
    if (section === undefined)
        return workspaceFile;
    const entryPrefix = `dsh-account-hub@${TARBALL_URL_PREFIX}`;
    let sectionEnd = section.sectionEnd;
    for (let index = section.sectionIndex + 1; index < sectionEnd;) {
        const trimmed = lines[index].trimStart();
        if (!trimmed.startsWith(entryPrefix)) {
            index += 1;
            continue;
        }
        const sha = trimmed.slice(entryPrefix.length).match(/^([0-9a-f]{40})(?=\s*:)/i)?.[1];
        if (sha === undefined || sha.toLowerCase() === normalizedKeepSha) {
            index += 1;
            continue;
        }
        lines.splice(index, 1);
        sectionEnd -= 1;
    }
    return joinLines(lines, newline, endsWithNewline);
}
/** 更新进行中的统一拒绝语：apply 与 check 共用，防第二个请求交叉读写磁盘。 */
const UPDATE_APPLY_IN_PROGRESS_ERROR = 'Account Hub 更新进行中，请稍后再试';
/** 模块级互斥：同一时刻只允许一笔 apply（或一笔 check）跑更新链路。 */
let updateApplyInProgress = false;
/**
 * 最近一笔 apply 的结果快照（成功与失败都存）：`update.status` 在 apply 结束
 * 后继续读它，页面刷新/重挂载也能拿到「已完成 / 已失败」而不是回到 idle。
 */
let lastAccountHubApplyOutcome = null;
/**
 * 读最近一笔 apply 的结果快照（无则 null）。RPC `update.status` 用它把
 * 「更新后页面刷新」的状态找回来，而不是永远停在 applying。
 */
export function lastAccountHubApplyResult() {
    return lastAccountHubApplyOutcome;
}
/**
 * 复位模块级互斥/进度/最近结果（仅供单测隔离用例间共享状态）。
 * 运行时没有任何调用方：更新链路自身从不复位 —— 锁由 apply 的 finally
 * 释放，最近结果由下一笔 apply 覆写。
 */
export function resetAccountHubUpdateState() {
    updateApplyInProgress = false;
    lastAccountHubApplyOutcome = null;
}
/**
 * 测试隔离钩子：把模块级互斥位与结果快照拨回初始态。
 *
 * 单测里「apply 进行中」用例会把模块状态打到非 idle，后续用例的
 * 「初始 status 应为 idle」断言会被残留污染 —— 仅测试文件在收尾时调用，
 * 产品代码零调用（不参与任何运行期行为）。
 */
export function resetAccountHubUpdateStateForTest() {
    updateApplyInProgress = false;
    lastAccountHubApplyOutcome = null;
}
export async function applyAccountHubUpdate(deps, channel = 'stable', onProgress = NOOP_ACCOUNT_HUB_UPDATE_PROGRESS, targetSha) {
    // 互斥：第二笔 apply / apply 进行中的 check 直接拒绝 —— remove→add 链路
    // 交叉执行会互相污染 package.json / lockfile / allowBuilds，谁后写谁说了算。
    if (updateApplyInProgress)
        throw new Error(UPDATE_APPLY_IN_PROGRESS_ERROR);
    updateApplyInProgress = true;
    try {
        const result = await applyAccountHubUpdateLocked(deps, channel, onProgress, targetSha);
        lastAccountHubApplyOutcome = {
            ok: true,
            previousSha: result.previousSha,
            currentSha: result.currentSha,
        };
        return result;
    }
    catch (error) {
        lastAccountHubApplyOutcome = {
            ok: false,
            previousSha: '',
            currentSha: '',
            error: error instanceof Error ? error.message : String(error),
        };
        throw error;
    }
    finally {
        updateApplyInProgress = false;
    }
}
async function applyAccountHubUpdateLocked(deps, channel = 'stable', onProgress = NOOP_ACCOUNT_HUB_UPDATE_PROGRESS, targetSha) {
    const installSha = targetSha === undefined
        ? (await fetchLatestVersion(deps, channel)).sha
        : normalizeTargetSha(targetSha);
    const lockPath = join(deps.profileRoot, 'pnpm-lock.yaml');
    const lockfile = await deps.readFile(lockPath);
    const previousSha = findAccountHubSha(lockfile) ?? '';
    if (targetSha === undefined && previousSha !== '' && installSha === previousSha)
        return { previousSha, currentSha: previousSha, log: '', restartRequired: true };
    const packagePath = join(deps.profileRoot, 'package.json');
    const workspacePath = join(deps.profileRoot, 'pnpm-workspace.yaml');
    const packageJson = await deps.readFile(packagePath);
    const workspace = await deps.readFile(workspacePath);
    const snapshots = [
        [lockPath, lockfile],
        [packagePath, packageJson],
        [workspacePath, workspace],
    ];
    const hasAccountHubDependency = /"dsh-account-hub"\s*:/.test(packageJson);
    const execOptions = {
        cwd: deps.profileRoot,
        timeoutMs: ACCOUNT_HUB_UPDATE_TIMEOUT_MS,
    };
    let removeLog = '';
    let addOutput;
    let currentSha;
    let log = '';
    try {
        if (hasAccountHubDependency) {
            onProgress('removing', '正在卸载旧版本…');
            let removeOutput;
            try {
                removeOutput = await deps.exec('pnpm', ['remove', 'dsh-account-hub'], withOutputProgress(execOptions, 'removing', onProgress));
            }
            catch (error) {
                throwWithLog(error, formatInstallLog(processOutputFromError(error)));
            }
            removeLog = formatInstallLog(removeOutput);
        }
        // pnpm remove 会删除 package.json 中的依赖字段，pnpm add 本身会写入带 SHA 的 pin；
        // 手工再写 pin 不仅冗余，还会在 remove 之后因字段不存在而必然失败。
        const updatedWorkspace = appendAccountHubAllowBuild(workspace, installSha);
        if (updatedWorkspace !== workspace)
            await deps.writeFile(workspacePath, updatedWorkspace);
        onProgress('installing', '正在安装新版本…');
        try {
            addOutput = await deps.exec('pnpm', ['add', `${ACCOUNT_HUB_GITHUB_PIN}#${installSha}`, '--config.minimum-release-age=0'], withOutputProgress(execOptions, 'installing', onProgress));
        }
        catch (error) {
            throwWithLog(error, joinInstallLogs(removeLog, formatInstallLog(processOutputFromError(error))));
        }
        log = joinInstallLogs(removeLog, formatInstallLog(addOutput));
        onProgress('verifying', '正在验证安装…');
        try {
            currentSha = extractAccountHubSha(await deps.readFile(lockPath));
        }
        catch (error) {
            throwWithLog(error, log);
        }
        if (currentSha !== installSha) {
            throwWithLog(new Error(`更新后 lockfile 未切换到最新版本（期望 ${installSha}，实际 ${currentSha}）`), log);
        }
    }
    catch (error) {
        await restoreAccountHubSnapshots(deps, snapshots);
        throw error;
    }
    try {
        const installedWorkspace = await deps.readFile(workspacePath);
        const cleanedWorkspace = removeStaleAllowBuildEntries(installedWorkspace, currentSha);
        if (cleanedWorkspace !== installedWorkspace)
            await deps.writeFile(workspacePath, cleanedWorkspace);
    }
    catch (error) {
        console.warn(`[account-hub] 清理旧 allowBuilds 条目失败：${errorMessage(error)}`);
    }
    return { previousSha, currentSha, log, restartRequired: true };
}
async function restoreAccountHubSnapshots(deps, snapshots) {
    for (const [path, snapshot] of snapshots) {
        try {
            const current = await deps.readFile(path);
            if (current !== snapshot)
                await deps.writeFile(path, snapshot);
        }
        catch (error) {
            console.error(`[account-hub] 回滚文件失败（${path}）：${errorMessage(error)}`);
        }
    }
}
function withOutputProgress(options, phase, onProgress) {
    if (onProgress === NOOP_ACCOUNT_HUB_UPDATE_PROGRESS)
        return options;
    return { ...options, onOutput: createOutputProgressReporter(phase, onProgress) };
}
function createOutputProgressReporter(phase, onProgress) {
    let pendingText = '';
    let latestDetail = '';
    return (text) => {
        pendingText += text;
        const lines = pendingText.split('\n');
        pendingText = lines.pop() ?? '';
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const detail = cleanOutputDetail(lines[index]);
            if (detail.length === 0)
                continue;
            if (detail !== latestDetail) {
                latestDetail = detail;
                onProgress(phase, detail);
            }
            return;
        }
        const pendingDetail = cleanOutputDetail(pendingText);
        if (pendingDetail.length > 0 && pendingDetail !== latestDetail) {
            latestDetail = pendingDetail;
            onProgress(phase, pendingDetail);
        }
    };
}
function cleanOutputDetail(line) {
    const cleaned = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}
function normalizeTargetSha(targetSha) {
    if (!/^[0-9a-f]{40}$/i.test(targetSha))
        throw new Error('targetSha 不是有效的 40 位 SHA');
    return targetSha.toLowerCase();
}
function leadingWhitespaceLength(line) {
    return line.match(/^[ \t]*/)?.[0].length ?? 0;
}
function joinLines(lines, newline, endsWithNewline) {
    return `${lines.join(newline)}${endsWithNewline ? newline : ''}`;
}
function joinInstallLogs(...logs) {
    return logs.filter((log) => log.length > 0).join('\n');
}
function formatInstallLog(output) {
    const sections = [];
    if (output.stdout.length > 0)
        sections.push(`stdout:\n${output.stdout}`);
    if (output.stderr.length > 0)
        sections.push(`stderr:\n${output.stderr}`);
    return sections.join('\n');
}
function processOutputFromError(error) {
    if (typeof error !== 'object' || error === null)
        return { stdout: '', stderr: '' };
    const output = error;
    return {
        stdout: typeof output.stdout === 'string' ? output.stdout : '',
        stderr: typeof output.stderr === 'string' ? output.stderr : '',
    };
}
function throwWithLog(error, log) {
    const message = errorMessage(error);
    const code = typeof error === 'object' && error !== null
        ? error.code
        : undefined;
    const original = typeof code === 'string' || typeof code === 'number'
        ? `${message} (code ${code})`
        : message;
    throw new Error(log.length > 0 ? `${original}\n\n${log}` : original);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=account-hub-update.js.map