
/**
 * PLEXtreon - EVE Online Dual-Role Patronage Platform
 * Lead Architect: Senior Software Engineer
 */

// --- SSO CONFIGURATION ---
const DEFAULT_CLIENT_ID = "4ad5f68b3968485fba0a322dbd79b990";
const REDIRECT_URI = "https://jp-673.github.io/ISKTREON/";

// Utility: Strict Base64URL for CCP PKCE compliance (RFC 7636)
const base64UrlEncode = (buffer) => {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
};

/**
 * HELPER: GET INITIALS
 * Extracts 1-2 letters from a name for stylized placeholders.
 */
const getInitials = (name) => {
    if (!name) return "??";
    const parts = name.split(/[\s_-]+/);
    if (parts.length > 1) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
};

let state = {
    user: null, 
    view: 'landing', 
    activeTab: 'creator-studio', 
    isLoading: false,
    isExchanging: false,
    error: null,
    debugLogs: [],
    walletJournal: [],
    stats: {
        uplinkRevenue: 0,
        uplinkSupport: 0,
        totalWallet: 0,
        patronCount: 0,
        subCount: 0,
        creatorTier: 'Frigate-Class'
    },
    activeModal: null,
    selectedCreator: null,
    isVerifying: false,
    mockCreators: [
        { 
            id: 92147137, name: "Lorumerth", type: "Industry & Market", 
            description: "Master of New Eden's economy. Deep dives into industry chains and logistics.",
            isLive: true, platform: "Twitch",
            tiers: [{ name: "Market Apprentice", cost: 25 }, { name: "Trade Master", cost: 100 }, { name: "Tycoon", cost: 500 }]
        },
        { 
            id: 2112445168, name: "Seffiess", type: "Abyssal Specialist", 
            description: "Elite Abyssal Deadspace runner. Mastering high-tier filaments and stormbringer doctrines.",
            isLive: true, platform: "Twitch",
            tiers: [{ name: "Abyssal Runner", cost: 25 }, { name: "Tier 6 Master", cost: 150 }, { name: "Filament Tycoon", cost: 600 }]
        },
        { 
            id: 95460599, name: "Anarckos", type: "Elite PVP", 
            description: "Small-gang specialist. Teaching pilots how to turn hulls into weapons.",
            isLive: false, platform: "YouTube",
            tiers: [{ name: "Frigate Pilot", cost: 25 }, { name: "Combat Vet", cost: 100 }, { name: "Warlord", cost: 500 }]
        }
    ],
    mockSubscriptions: [
        { id: 1, name: "Lorumerth", tier: "Market Apprentice", cost: 50, nextBill: "2024-06-12" }
    ]
};

function logDebug(msg, type = 'INFO') {
    const entry = `[${new Date().toLocaleTimeString()}] ${type}: ${msg}`;
    console.log(entry);
    state.debugLogs.push(entry);
    if (state.debugLogs.length > 30) state.debugLogs.shift();
    render();
}

function setState(newState) {
    state = { ...state, ...newState };
    render();
}

// --- ESI & AUTH ---
async function startLogin() {
    logDebug(`Contacting CCP SSO... Redirecting to: ${REDIRECT_URI}`);
    setState({ isLoading: true, error: null });
    try {
        const array = new Uint8Array(32);
        window.crypto.getRandomValues(array);
        const verifier = base64UrlEncode(array);
        localStorage.setItem('eve_pkce_verifier', verifier);
        const encoder = new TextEncoder();
        const data = encoder.encode(verifier);
        const hash = await window.crypto.subtle.digest('SHA-256', data);
        const challenge = base64UrlEncode(hash);
        const url = new URL('https://login.eveonline.com/v2/oauth/authorize/');
        url.searchParams.append('response_type', 'code');
        url.searchParams.append('redirect_uri', REDIRECT_URI);
        url.searchParams.append('client_id', DEFAULT_CLIENT_ID);
        url.searchParams.append('scope', 'publicData esi-wallet.read_character_wallet.v1');
        url.searchParams.append('code_challenge', challenge);
        url.searchParams.append('code_challenge_method', 'S256');
        url.searchParams.append('state', Math.random().toString(36).substring(7));
        window.location.href = url.toString();
    } catch (e) {
        logDebug(e.message, 'ERROR');
        setState({ error: "SSO Initialization Failed", isLoading: false });
    }
}

async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return;
    setState({ isExchanging: true });
    try {
        const verifier = localStorage.getItem('eve_pkce_verifier');
        const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', client_id: DEFAULT_CLIENT_ID, code_verifier: verifier, code, redirect_uri: REDIRECT_URI })
        }).then(r => r.json());
        const char = await fetch('https://login.eveonline.com/oauth/verify', { headers: { 'Authorization': `Bearer ${tokenRes.access_token}` } }).then(r => r.json());
        const publicInfo = await fetch(`https://esi.evetech.net/latest/characters/${char.CharacterID}/`).then(r => r.json());
        const corpInfo = await fetch(`https://esi.evetech.net/latest/corporations/${publicInfo.corporation_id}/`).then(r => r.json());
        window.history.replaceState({}, document.title, window.location.pathname);
        setState({
            user: { 
                id: char.CharacterID, name: char.CharacterName, 
                avatar: `https://images.evetech.net/characters/${char.CharacterID}/portrait?size=512`, 
                token: tokenRes.access_token, corpName: corpInfo.name, corpId: publicInfo.corporation_id, 
                securityStatus: publicInfo.security_status.toFixed(1) 
            },
            view: 'dashboard', isExchanging: false
        });
        fetchData();
    } catch (e) { logDebug(e.message, 'ERROR'); setState({ error: "Handshake Failed", isExchanging: false }); }
}

async function fetchData() {
    if (!state.user) return;
    try {
        const journal = await fetch(`https://esi.evetech.net/latest/characters/${state.user.id}/wallet/journal/`, { headers: { 'Authorization': `Bearer ${state.user.token}` } }).then(r => r.json());
        const txs = (Array.isArray(journal) ? journal : []).map(j => ({ id: j.id, date: new Date(j.date).toLocaleString(), amount: Math.floor(j.amount), reason: j.reason || 'Personal Transaction', type: j.amount > 0 ? 'IN' : 'OUT' }));
        const uplinkRevenue = txs.filter(t => t.type === 'IN' && t.reason.startsWith('PX-')).reduce((a, b) => a + b.amount, 0);
        const balance = await fetch(`https://esi.evetech.net/latest/characters/${state.user.id}/wallet/`, { headers: { 'Authorization': `Bearer ${state.user.token}` } }).then(r => r.json());
        setState({
            walletJournal: txs,
            stats: { ...state.stats, uplinkRevenue, totalWallet: Math.floor(balance), patronCount: txs.filter(t => t.type === 'IN' && t.reason.startsWith('PX-')).length }
        });
    } catch (e) { logDebug(e.message, 'ERROR'); }
}

// --- TAB NAVIGATION ---
window.setTab = (tab) => setState({ activeTab: tab });
window.logout = () => { localStorage.clear(); location.reload(); };

// --- MODAL ACTIONS ---
window.openSubModal = (creatorId) => {
    const creator = state.mockCreators.find(c => c.id === creatorId);
    setState({ activeModal: 'subscribe', selectedCreator: { ...creator, selectedTier: 0, phase: 'select' } });
};
window.closeModal = () => setState({ activeModal: null, selectedCreator: null, isVerifying: false });
window.selectTier = (idx) => setState({ selectedCreator: { ...state.selectedCreator, selectedTier: idx } });
window.initiateLink = () => setState({ selectedCreator: { ...state.selectedCreator, phase: 'instructions', reasonCode: `PX-${Math.floor(Math.random() * 999999).toString().padStart(6, '0')}` } });
window.verifyTelemetry = () => {
    setState({ isVerifying: true });
    setTimeout(() => {
        const creator = state.selectedCreator;
        const tier = creator.tiers[creator.selectedTier];
        const newSub = { id: Date.now(), name: creator.name, tier: tier.name, cost: tier.cost, nextBill: "2024-07-12" };
        setState({
            mockSubscriptions: [...state.mockSubscriptions, newSub],
            activeModal: null, selectedCreator: null, isVerifying: false, activeTab: 'fan-zone'
        });
    }, 1500);
};

// --- UI COMPONENTS ---
const Sidebar = () => `
    <aside class="w-80 bg-black/40 border-r border-slate-800 flex flex-col backdrop-blur-3xl">
        <div class="p-8 border-b border-slate-800/50">
            <img src="${state.user.avatar}" class="w-full aspect-square rounded-2xl border border-slate-700 mb-6" />
            <h2 class="text-xl font-black italic tracking-tighter uppercase text-white truncate text-glow">${state.user.name}</h2>
            <p class="text-[9px] text-slate-500 font-black uppercase tracking-widest truncate mt-1">${state.user.corpName}</p>
        </div>
        <div class="flex-1 overflow-y-auto p-4 space-y-2 mt-4">
            ${NavItem('creator-studio', 'layout-dashboard', 'Studio')}
            ${NavItem('fan-zone', 'heart', 'My Support')}
            ${NavItem('discover', 'search', 'Find Creators')}
            ${NavItem('ledger', 'list', 'Journal')}
        </div>
        <div class="p-8 border-t border-slate-800/50">
            <button onclick="window.logout()" class="w-full flex items-center justify-center space-x-2 p-3 rounded-xl bg-slate-900/50 text-slate-600 text-[9px] font-black uppercase tracking-widest hover:text-red-400">
                <i data-lucide="log-out" class="w-3 h-3"></i> <span>Disconnect</span>
            </button>
        </div>
    </aside>
`;

const NavItem = (id, icon, label) => `
    <button onclick="window.setTab('${id}')" class="w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-all ${state.activeTab === id ? 'bg-blue-600/10 text-white border border-blue-500/10' : 'text-slate-500 hover:text-slate-300'}">
        <i data-lucide="${icon}" class="w-3.5 h-3.5"></i>
        <span class="text-[10px] font-black uppercase tracking-widest">${label}</span>
    </button>
`;

const DiscoverTab = () => `
    <div class="space-y-12 animate-fade-in">
        <header>
            <h2 class="text-6xl font-black italic tracking-tighter uppercase text-white">Discover</h2>
            <p class="text-[10px] text-blue-400 font-bold uppercase tracking-[0.3em] mt-2 italic">Verified New Eden Talents</p>
        </header>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-8 pb-12">
            ${state.mockCreators.map(creator => `
                <div class="glass p-8 rounded-3xl border-slate-800/50 group hover:border-blue-500/20 transition-all">
                    <div class="flex justify-between items-start mb-6">
                        <div class="w-16 h-16 rounded-xl border border-slate-700 bg-blue-600/10 flex items-center justify-center text-blue-400 text-xl font-black italic shadow-[0_0_15px_rgba(59,130,246,0.1)]">
                            ${getInitials(creator.name)}
                        </div>
                        ${creator.isLive ? `<span class="bg-red-600 text-white text-[8px] font-black px-2 py-1 rounded uppercase tracking-widest animate-pulse">Live on ${creator.platform}</span>` : ''}
                    </div>
                    <h3 class="text-2xl font-black italic tracking-tighter text-white uppercase">${creator.name}</h3>
                    <p class="text-[9px] font-black text-blue-400 uppercase tracking-widest mb-4 italic">${creator.type}</p>
                    <p class="text-slate-400 text-sm leading-relaxed mb-8">${creator.description}</p>
                    <button onclick="window.openSubModal(${creator.id})" class="w-full py-4 bg-white text-black font-black text-[10px] uppercase tracking-widest hover:bg-blue-50 rounded-sm">Initiate Patronage</button>
                </div>
            `).join('')}
        </div>
    </div>
`;

const FanZoneTab = () => `
    <div class="space-y-12 animate-fade-in">
        <header>
            <h2 class="text-6xl font-black italic tracking-tighter uppercase text-white">Fan Zone</h2>
            <p class="text-[10px] text-blue-400 font-bold uppercase tracking-[0.3em] mt-2 italic">Active Support Uplinks</p>
        </header>
        ${state.mockSubscriptions.length === 0 ? `
            <div class="glass p-20 rounded-3xl text-center border-dashed border-slate-800">
                <p class="text-slate-500 uppercase font-black italic text-xs">No active uplinks found in telemetry.</p>
            </div>
        ` : `
            <div class="grid grid-cols-1 gap-4">
                ${state.mockSubscriptions.map(sub => `
                    <div class="glass p-6 rounded-2xl flex items-center justify-between border-slate-800/50">
                        <div class="flex items-center space-x-6">
                            <div class="w-12 h-12 bg-blue-600/10 rounded-full flex items-center justify-center text-blue-400 font-black italic text-xs border border-blue-500/20">
                                ${getInitials(sub.name)}
                            </div>
                            <div>
                                <h4 class="text-lg font-black italic text-white uppercase">${sub.name}</h4>
                                <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest">${sub.tier} • ${sub.cost}M ISK / MO</p>
                            </div>
                        </div>
                        <div class="text-right">
                            <p class="text-[8px] font-black text-slate-600 uppercase tracking-widest">Next Billing Cycle</p>
                            <p class="text-xs font-black text-blue-400 mono">${sub.nextBill}</p>
                        </div>
                    </div>
                `).join('')}
            </div>
        `}
    </div>
`;

const Modal = () => {
    if (!state.activeModal || !state.selectedCreator) return '';
    const creator = state.selectedCreator;
    return `
        <div class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/90 backdrop-blur-sm animate-fade-in">
            <div class="max-w-xl w-full glass rounded-3xl p-10 border-blue-500/20 shadow-2xl relative overflow-hidden">
                <button onclick="window.closeModal()" class="absolute top-6 right-6 text-slate-500 hover:text-white"><i data-lucide="x" class="w-6 h-6"></i></button>
                
                ${creator.phase === 'select' ? `
                    <h3 class="text-3xl font-black italic tracking-tighter text-white uppercase mb-2">Select Support Tier</h3>
                    <p class="text-[9px] text-slate-500 font-black uppercase tracking-widest mb-8 italic">Target Pilot: ${creator.name}</p>
                    <div class="space-y-3 mb-8">
                        ${creator.tiers.map((tier, idx) => `
                            <button onclick="window.selectTier(${idx})" class="w-full p-6 rounded-2xl text-left border transition-all ${creator.selectedTier === idx ? 'bg-blue-600/10 border-blue-500/40' : 'bg-slate-900/40 border-slate-800 hover:border-slate-700'}">
                                <div class="flex justify-between items-center">
                                    <span class="text-sm font-black italic text-white uppercase tracking-widest">${tier.name}</span>
                                    <span class="text-lg font-black text-blue-400 italic">${tier.cost}M <span class="text-[9px] uppercase not-italic">ISK</span></span>
                                </div>
                            </button>
                        `).join('')}
                    </div>
                    <button onclick="window.initiateLink()" class="w-full py-5 bg-blue-600 text-white font-black text-xs uppercase tracking-[0.2em] rounded-sm hover:bg-blue-500 shadow-glow transition-all">Establish Neural Link</button>
                ` : `
                    <div class="text-center space-y-6">
                        <div class="w-20 h-20 bg-blue-600/10 rounded-full flex items-center justify-center mx-auto text-blue-400 border border-blue-500/30 text-2xl font-black italic">
                            ${getInitials(creator.name)}
                        </div>
                        <h3 class="text-2xl font-black italic tracking-tighter text-white uppercase">Verification Instructions</h3>
                        <p class="text-slate-400 text-sm">Transfer <span class="text-white font-black italic">${creator.tiers[creator.selectedTier].cost}M ISK</span> to <span class="text-white font-black italic">${creator.name}</span> in-game.</p>
                        <div class="bg-black/50 p-6 rounded-2xl border border-blue-500/20">
                            <p class="text-[8px] font-black text-blue-500 uppercase tracking-[0.3em] mb-2">Required Transaction Reason</p>
                            <span class="text-3xl font-black text-white italic tracking-widest mono">${creator.reasonCode}</span>
                        </div>
                        <p class="text-[10px] text-slate-600 italic">Our telemetry scanners will verify this code in your character's wallet journal automatically.</p>
                        <button onclick="window.verifyTelemetry()" class="w-full py-5 bg-white text-black font-black text-xs uppercase tracking-[0.2em] rounded-sm flex items-center justify-center space-x-2">
                            ${state.isVerifying ? `<div class="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin"></div>` : `<i data-lucide="refresh-cw" class="w-4 h-4"></i> <span>Scan ESI Journal</span>`}
                        </button>
                    </div>
                `}
            </div>
        </div>
    `;
};

const CreatorTab = () => `
    <div class="space-y-12 animate-fade-in">
        <header class="flex justify-between items-start">
            <div>
                <h2 class="text-6xl font-black italic tracking-tighter uppercase text-white">Studio</h2>
                <p class="text-[10px] text-blue-400 font-bold uppercase tracking-[0.3em] mt-2 italic">Verified PLEXtreon Revenue</p>
            </div>
        </header>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="glass p-8 rounded-3xl relative overflow-hidden group hover:border-blue-500/10 transition-all">
                <h4 class="text-[9px] font-black text-slate-600 uppercase tracking-[0.3em] mb-4 italic">Platform Revenue</h4>
                <div class="flex items-baseline space-x-2">
                    <span class="text-5xl font-black italic tracking-tighter text-blue-400">${state.stats.uplinkRevenue.toLocaleString()}</span>
                    <span class="text-slate-700 font-black text-[10px] uppercase italic tracking-widest">ISK</span>
                </div>
            </div>
            <div class="glass p-8 rounded-3xl relative overflow-hidden group hover:border-blue-500/10 transition-all">
                <h4 class="text-[9px] font-black text-slate-600 uppercase tracking-[0.3em] mb-4 italic">Direct Patrons</h4>
                <div class="flex items-baseline space-x-2">
                    <span class="text-5xl font-black italic tracking-tighter text-white">${state.stats.patronCount}</span>
                    <span class="text-slate-700 font-black text-[10px] uppercase italic tracking-widest">PILOTS</span>
                </div>
            </div>
        </div>
        <div class="glass p-8 rounded-3xl border-slate-800/50">
            <p class="text-[9px] font-black text-slate-600 uppercase tracking-[0.3em] mb-4 italic">Available Wallet ISK</p>
            <div class="flex items-baseline space-x-2">
                <span class="text-3xl font-black text-white italic mono">${state.stats.totalWallet.toLocaleString()}</span>
                <span class="text-[10px] font-black text-slate-700 uppercase">Total</span>
            </div>
        </div>
    </div>
`;

const LedgerTab = () => `
    <div class="space-y-10 animate-fade-in">
        <header><h2 class="text-6xl font-black italic tracking-tighter uppercase text-white">Archives</h2></header>
        <div class="lg:col-span-2 glass rounded-3xl overflow-hidden h-[600px] flex flex-col">
            <div class="overflow-y-auto flex-1">
                <table class="w-full text-left">
                    <thead class="bg-slate-900 text-slate-600 font-black uppercase text-[9px] tracking-widest sticky top-0 border-b border-slate-800">
                        <tr><th class="px-6 py-4">Time</th><th class="px-6 py-4">Reason</th><th class="px-6 py-4 text-right">Flow</th></tr>
                    </thead>
                    <tbody class="divide-y divide-slate-800/40 mono text-[10px]">
                        ${state.walletJournal.map(tx => `
                            <tr class="hover:bg-blue-500/5">
                                <td class="px-6 py-4 text-slate-600 whitespace-nowrap">${tx.date}</td>
                                <td class="px-6 py-4 text-slate-200">${tx.reason.startsWith('PX-') ? `<span class="bg-blue-600/20 text-blue-400 px-1.5 py-0.5 rounded text-[8px] font-black mr-2">PX-LINK</span>` : ''}${tx.reason}</td>
                                <td class="px-6 py-4 text-right font-black ${tx.type === 'IN' ? 'text-green-400' : 'text-red-400'}">${tx.type === 'IN' ? '+' : '-'}${Math.abs(tx.amount).toLocaleString()}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
`;

const LandingPage = () => `
    <div class="h-screen flex flex-col items-center justify-center p-6 bg-[#020617]">
        <div class="text-center space-y-8 max-w-xl">
            <h1 class="text-8xl font-black tracking-tighter text-white italic drop-shadow-[0_0_20px_rgba(59,130,246,0.3)]">PLEXtreon</h1>
            <p class="text-slate-600 italic">Fueling the New Eden creator economy via ESI-verified telemetry.</p>
            ${state.isLoading || state.isExchanging ? `
                <div class="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
            ` : `
                <button onclick="window.startLogin()" class="bg-white text-black px-12 py-5 rounded-sm font-black text-xs uppercase tracking-widest hover:bg-blue-50 active:scale-95 transition-all shadow-2xl">Establish Neural Link</button>
            `}
        </div>
    </div>
`;

function render() {
    const root = document.getElementById('app');
    if (!root) return;
    if (state.view === 'landing') root.innerHTML = LandingPage();
    else {
        root.innerHTML = `
            <div class="flex h-screen bg-[#020617] text-slate-100 relative">
                ${Sidebar()}
                <main class="flex-1 overflow-y-auto p-16">
                    <div class="max-w-6xl mx-auto">
                        ${state.activeTab === 'creator-studio' ? CreatorTab() : 
                          state.activeTab === 'discover' ? DiscoverTab() :
                          state.activeTab === 'fan-zone' ? FanZoneTab() : LedgerTab()}
                    </div>
                </main>
                ${Modal()}
            </div>
        `;
    }
    if (window.lucide) window.lucide.createIcons();
}

window.startLogin = startLogin;
document.addEventListener('DOMContentLoaded', () => { handleCallback(); render(); });
