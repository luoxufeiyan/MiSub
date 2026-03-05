/**
 * 手工节点调试处理器
 * 用于排查手工节点在订阅输出中消失的问题
 */

import { StorageFactory } from '../../storage-adapter.js';
import { KV_KEY_SUBS } from '../config.js';
import { fixNodeUrlEncoding } from '../../utils/node-utils.js';
import { applyManualNodeName } from '../utils/node-cleaner.js';
import { parseNodeList } from '../utils/node-parser.js';

/**
 * 处理手工节点调试请求
 * @param {Object} context - Cloudflare 上下文
 * @returns {Promise<Response>} JSON 格式的调试信息
 */
export async function handleManualNodeDebug(context) {
    const { env, request } = context;
    const url = new URL(request.url);
    
    // 简单的认证保护（可选）
    const debugToken = url.searchParams.get('token');
    // 如果你想添加保护，取消下面的注释并设置环境变量 DEBUG_TOKEN
    // if (debugToken !== env.DEBUG_TOKEN) {
    //     return new Response('Unauthorized', { status: 401 });
    // }
    
    try {
        const storageAdapter = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
        const allMisubs = await storageAdapter.get(KV_KEY_SUBS) || [];
        
        // 筛选手工节点（非 HTTP/HTTPS 开头的）
        const manualNodes = allMisubs.filter(sub => {
            const url = typeof sub?.url === 'string' ? sub.url.trim() : '';
            return Boolean(url) && !url.toLowerCase().startsWith('http');
        });
        
        const debugInfo = {
            timestamp: new Date().toISOString(),
            totalManualNodes: manualNodes.length,
            totalSubscriptions: allMisubs.length - manualNodes.length,
            nodes: []
        };
        
        // 逐个处理手工节点
        for (const node of manualNodes) {
            const rawUrl = node.url.trim();
            const nodeDebug = {
                id: node.id || 'unknown',
                original: rawUrl,
                customName: node.name || '(无自定义名称)',
                enabled: node.enabled !== false,
                steps: [],
                warnings: []
            };
            
            try {
                // 检查节点是否启用
                if (node.enabled === false) {
                    nodeDebug.warnings.push('节点已禁用，不会出现在订阅输出中');
                }
                
                // 步骤 1：检查协议
                const protocolMatch = rawUrl.match(/^([^:]+):\/\//);
                const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : 'unknown';
                nodeDebug.steps.push({
                    step: 1,
                    action: '检测协议',
                    protocol: protocol,
                    supported: ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'hysteria', 'tuic', 'snell', 'socks5', 'socks', 'http', 'anytls'].includes(protocol)
                });
                
                // 步骤 2：修复编码
                let processedUrl = fixNodeUrlEncoding(rawUrl);
                nodeDebug.steps.push({
                    step: 2,
                    action: 'fixNodeUrlEncoding',
                    input: rawUrl,
                    output: processedUrl,
                    changed: processedUrl !== rawUrl
                });
                
                // 步骤 3：应用自定义名称
                const customNodeName = node.name?.trim();
                if (customNodeName) {
                    const beforeName = processedUrl;
                    try {
                        processedUrl = applyManualNodeName(processedUrl, customNodeName);
                        nodeDebug.steps.push({
                            step: 3,
                            action: 'applyManualNodeName',
                            customName: customNodeName,
                            input: beforeName,
                            output: processedUrl,
                            changed: processedUrl !== beforeName,
                            success: true
                        });
                    } catch (e) {
                        nodeDebug.steps.push({
                            step: 3,
                            action: 'applyManualNodeName',
                            customName: customNodeName,
                            success: false,
                            error: e.message
                        });
                        nodeDebug.warnings.push(`应用自定义名称失败: ${e.message}`);
                    }
                } else {
                    nodeDebug.steps.push({
                        step: 3,
                        action: 'applyManualNodeName',
                        skipped: true,
                        reason: '无自定义名称'
                    });
                }
                
                // 步骤 4：解析节点列表
                try {
                    const parsed = parseNodeList(processedUrl);
                    const wasFiltered = parsed.length === 0;
                    
                    nodeDebug.steps.push({
                        step: 4,
                        action: 'parseNodeList',
                        input: processedUrl,
                        result: wasFiltered ? 'FILTERED (节点被过滤)' : 'SUCCESS',
                        parsedCount: parsed.length,
                        parsedNodes: parsed.map(n => ({
                            protocol: n.protocol,
                            name: n.name,
                            region: n.region,
                            server: n.server,
                            port: n.port
                        }))
                    });
                    
                    if (wasFiltered) {
                        nodeDebug.warnings.push('⚠️ 节点在 parseNodeList 阶段被过滤，这是问题所在！');
                        nodeDebug.warnings.push('可能原因：');
                        nodeDebug.warnings.push('1. 节点格式不符合标准');
                        nodeDebug.warnings.push('2. 协议不支持或拼写错误');
                        nodeDebug.warnings.push('3. 缺少必要的参数（如端口号）');
                        
                        // 针对 SOCKS5 的特殊提示
                        if (protocol === 'socks5') {
                            nodeDebug.warnings.push('');
                            nodeDebug.warnings.push('SOCKS5 节点标准格式：');
                            nodeDebug.warnings.push('  socks5://127.0.0.1:1080#节点名称');
                            nodeDebug.warnings.push('  socks5://user:pass@127.0.0.1:1080#节点名称');
                            nodeDebug.warnings.push('');
                            nodeDebug.warnings.push('请检查：');
                            nodeDebug.warnings.push('  ✓ 是否包含端口号');
                            nodeDebug.warnings.push('  ✓ 协议是否为 socks5（不是 socks）');
                            nodeDebug.warnings.push('  ✓ 格式是否完整');
                        }
                    }
                } catch (e) {
                    nodeDebug.steps.push({
                        step: 4,
                        action: 'parseNodeList',
                        result: 'ERROR',
                        error: e.message,
                        stack: e.stack
                    });
                    nodeDebug.warnings.push(`解析节点时发生错误: ${e.message}`);
                }
                
                // 最终状态
                nodeDebug.finalUrl = processedUrl;
                nodeDebug.willAppearInSubscription = nodeDebug.enabled && 
                    nodeDebug.steps.some(s => s.action === 'parseNodeList' && s.result === 'SUCCESS');
                nodeDebug.success = true;
                
            } catch (error) {
                nodeDebug.error = error.message;
                nodeDebug.errorStack = error.stack;
                nodeDebug.success = false;
                nodeDebug.willAppearInSubscription = false;
                nodeDebug.warnings.push(`处理节点时发生致命错误: ${error.message}`);
            }
            
            debugInfo.nodes.push(nodeDebug);
        }
        
        // 添加总结
        const filteredCount = debugInfo.nodes.filter(n => !n.willAppearInSubscription).length;
        debugInfo.summary = {
            total: debugInfo.nodes.length,
            willAppear: debugInfo.nodes.length - filteredCount,
            filtered: filteredCount,
            disabled: debugInfo.nodes.filter(n => !n.enabled).length
        };
        
        // 如果有被过滤的节点，添加建议
        if (filteredCount > 0) {
            debugInfo.recommendations = [
                '发现有节点被过滤，请检查以下内容：',
                '1. 节点格式是否正确（特别是端口号）',
                '2. 协议名称是否正确（socks5 不是 socks）',
                '3. 是否包含所有必需的参数',
                '4. 查看每个节点的 warnings 字段获取详细建议'
            ];
        }
        
        return new Response(JSON.stringify(debugInfo, null, 2), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
        });
        
    } catch (error) {
        return new Response(JSON.stringify({
            error: 'Internal Server Error',
            message: error.message,
            stack: error.stack
        }, null, 2), {
            status: 500,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}
