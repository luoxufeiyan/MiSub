/**
 * 订阅输出调试处理器
 * 用于排查节点在订阅输出中消失的问题
 */

import { StorageFactory } from '../../storage-adapter.js';
import { KV_KEY_SUBS, KV_KEY_PROFILES, KV_KEY_SETTINGS, DEFAULT_SETTINGS } from '../config.js';
import { migrateConfigSettings } from '../utils.js';
import { generateCombinedNodeList } from '../../services/subscription-service.js';

/**
 * 处理订阅输出调试请求
 * @param {Object} context - Cloudflare 上下文
 * @returns {Promise<Response>} JSON 格式的调试信息
 */
export async function handleSubscriptionDebug(context) {
    const { env, request } = context;
    const url = new URL(request.url);
    
    // 获取参数
    const token = url.searchParams.get('token');
    const profileId = url.searchParams.get('profile');
    
    try {
        const storageAdapter = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
        const [settingsData, misubsData, profilesData] = await Promise.all([
            storageAdapter.get(KV_KEY_SETTINGS),
            storageAdapter.get(KV_KEY_SUBS),
            storageAdapter.get(KV_KEY_PROFILES)
        ]);
        
        const settings = settingsData || {};
        const config = migrateConfigSettings({ ...DEFAULT_SETTINGS, ...settings });
        const allMisubs = misubsData || [];
        const allProfiles = profilesData || [];
        
        // 筛选手工节点
        const manualNodes = allMisubs.filter(sub => {
            const url = typeof sub?.url === 'string' ? sub.url.trim() : '';
            return Boolean(url) && !url.toLowerCase().startsWith('http');
        });
        
        // 筛选订阅源
        const subscriptions = allMisubs.filter(sub => {
            const url = typeof sub?.url === 'string' ? sub.url.trim() : '';
            return Boolean(url) && url.toLowerCase().startsWith('http');
        });
        
        const debugInfo = {
            timestamp: new Date().toISOString(),
            config: {
                profileToken: config.profileToken ? '(已设置)' : '(未设置)',
                enableAccessLog: config.enableAccessLog,
                enableTrafficNode: config.enableTrafficNode
            },
            totalManualNodes: manualNodes.length,
            enabledManualNodes: manualNodes.filter(n => n.enabled !== false).length,
            totalSubscriptions: subscriptions.length,
            enabledSubscriptions: subscriptions.filter(s => s.enabled !== false).length,
            totalProfiles: allProfiles.length,
            manualNodesList: manualNodes.map(n => ({
                id: n.id,
                name: n.name || '(无名称)',
                url: n.url,
                enabled: n.enabled !== false
            })),
            profiles: allProfiles.map(p => ({
                id: p.id,
                customId: p.customId,
                name: p.name,
                enabled: p.enabled !== false,
                subscriptions: p.subscriptions || [],
                manualNodes: p.manualNodes || [],
                nodeTransform: p.nodeTransform?.enabled ? '启用' : '禁用',
                dedup: p.nodeTransform?.dedup?.enabled ? '启用' : '禁用'
            }))
        };
        
        // 如果提供了 token 和 profile，尝试生成订阅
        if (token && profileId) {
            if (token !== config.profileToken) {
                debugInfo.subscriptionTest = {
                    error: 'Token 不匹配',
                    providedToken: token,
                    expectedToken: config.profileToken ? '(已设置，但不匹配)' : '(未设置)'
                };
            } else {
                const profile = allProfiles.find(p => 
                    (p.customId && p.customId === profileId) || p.id === profileId
                );
                
                if (!profile) {
                    debugInfo.subscriptionTest = {
                        error: 'Profile 不存在',
                        providedProfileId: profileId,
                        availableProfiles: allProfiles.map(p => ({
                            id: p.id,
                            customId: p.customId,
                            name: p.name
                        }))
                    };
                } else if (!profile.enabled) {
                    debugInfo.subscriptionTest = {
                        error: 'Profile 已禁用',
                        profile: {
                            id: profile.id,
                            name: profile.name,
                            enabled: false
                        }
                    };
                } else {
                    // 获取 Profile 关联的订阅和手工节点
                    const profileSubIds = profile.subscriptions || [];
                    const profileNodeIds = profile.manualNodes || [];
                    const allProfileIds = [...profileSubIds, ...profileNodeIds];
                    const targetMisubs = allMisubs.filter(sub => 
                        allProfileIds.includes(sub.id) && sub.enabled !== false
                    );
                    
                    debugInfo.subscriptionTest = {
                        profile: {
                            id: profile.id,
                            customId: profile.customId,
                            name: profile.name,
                            enabled: true
                        },
                        linkedSubscriptions: targetMisubs.length,
                        linkedManualNodes: targetMisubs.filter(sub => {
                            const url = typeof sub?.url === 'string' ? sub.url.trim() : '';
                            return Boolean(url) && !url.toLowerCase().startsWith('http');
                        }).length,
                        linkedHttpSubscriptions: targetMisubs.filter(sub => {
                            const url = typeof sub?.url === 'string' ? sub.url.trim() : '';
                            return Boolean(url) && url.toLowerCase().startsWith('http');
                        }).length
                    };
                    
                    // 尝试生成节点列表
                    try {
                        const nodeList = await generateCombinedNodeList(
                            context,
                            config,
                            'DebugAgent/1.0',
                            targetMisubs,
                            '',
                            profile.prefixSettings || null,
                            true // debug mode
                        );
                        
                        const nodes = nodeList.split('\n').filter(Boolean);
                        const socks5Nodes = nodes.filter(n => n.startsWith('socks5://'));
                        
                        debugInfo.subscriptionTest.generatedNodes = {
                            total: nodes.length,
                            socks5Count: socks5Nodes.length,
                            socks5Nodes: socks5Nodes.map(n => {
                                const hashIndex = n.lastIndexOf('#');
                                const name = hashIndex !== -1 ? decodeURIComponent(n.substring(hashIndex + 1)) : '(无名称)';
                                return { url: n, name };
                            }),
                            sample: nodes.slice(0, 5).map(n => {
                                const hashIndex = n.lastIndexOf('#');
                                const name = hashIndex !== -1 ? decodeURIComponent(n.substring(hashIndex + 1)) : '(无名称)';
                                const protocol = n.match(/^([^:]+):/)?.[1] || 'unknown';
                                return { protocol, name };
                            })
                        };
                        
                        if (socks5Nodes.length === 0 && manualNodes.some(n => n.url.startsWith('socks5://'))) {
                            debugInfo.subscriptionTest.warning = '⚠️ 有 SOCKS5 手工节点，但生成的订阅中没有 SOCKS5 节点！';
                            debugInfo.subscriptionTest.possibleReasons = [
                                '1. Profile 没有关联包含 SOCKS5 节点的订阅',
                                '2. SOCKS5 节点被 Profile 的过滤规则排除',
                                '3. SOCKS5 节点被智能去重过滤',
                                '4. SOCKS5 节点在节点转换管道中被过滤'
                            ];
                        }
                    } catch (e) {
                        debugInfo.subscriptionTest.error = `生成订阅失败: ${e.message}`;
                        debugInfo.subscriptionTest.stack = e.stack;
                    }
                }
            }
        } else {
            debugInfo.hint = '提供 token 和 profile 参数可以测试订阅生成';
            debugInfo.example = `/debug/subscription?token=YOUR_TOKEN&profile=YOUR_PROFILE_ID`;
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
