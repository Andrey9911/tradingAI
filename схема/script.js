document.addEventListener("DOMContentLoaded", function () {
    const tg = window.Telegram?.WebApp;
    if (tg) {
        tg.expand();
        // adapt background and colors
        document.body.style.backgroundColor = tg.themeParams.bg_color || '#0b0f19';
        document.body.style.color = tg.themeParams.text_color || '#e2e8f0';
    }

    const urlParams = new URLSearchParams(window.location.search);
    const tokenSymbol = urlParams.get('symbol') || 'Токен';
    document.getElementById('tokenSymbol').innerText = tokenSymbol;

    let graphData = { nodes: [], edges: [] };
    try {
        const payload = urlParams.get('data');
        if (payload) {
            graphData = JSON.parse(atob(payload));
        }
    } catch (e) {
        console.error("Failed to parse graph data:", e);
    }

    // Default mock data for testing if no URL params
    if (!graphData.nodes || graphData.nodes.length === 0) {
        graphData.nodes = [
            { address: 'dev123', shortAddress: 'dev...123', pct: 15, roles: ['developer'] },
            { address: 'hold1', shortAddress: 'hld...1', pct: 8, fundingSource: 'dev123', roles: ['holder'] },
            { address: 'snip1', shortAddress: 'snp...1', pct: 12, fundingSource: 'hold1', roles: ['sniper'] },
            { address: 'hold2', shortAddress: 'hld...2', pct: 5, fundingSource: 'dev123', roles: ['holder'] },
            { address: 'hold3', shortAddress: 'hld...3', pct: 3, fundingSource: 'hold2', roles: ['holder'] },
        ];
        graphData.edges = [
            { source: 'dev123', target: 'hold1', type: 'dev_transfer' },
            { source: 'dev123', target: 'hold2', type: 'dev_transfer' },
            { source: 'hold1', target: 'snip1', type: 'shared_funding_source' },
            { source: 'hold2', target: 'hold3', type: 'shared_funding_source' },
        ];
    }

    const nodes = [];
    const edges = [];
    const nodeMap = new Map();

    // Map roles to colors
    const roleColors = {
        developer: { background: '#8b5cf6', border: '#a78bfa' }, // purple
        sniper: { background: '#ef4444', border: '#f87171' },    // red
        holder: { background: '#3b82f6', border: '#60a5fa' }     // blue
    };

    // Calculate node size based on pct
    graphData.nodes.forEach((item) => {
        const size = Math.max(15, Math.min(60, 15 + (item.pct * 2)));
        const primaryRole = (item.roles && item.roles.length > 0) ? item.roles[0] : 'holder';
        const color = roleColors[primaryRole] || roleColors.holder;
        
        nodes.push({
            id: item.address,
            label: item.shortAddress + '\n' + item.pct.toFixed(1) + '%',
            shape: 'dot',
            size: size,
            color: color,
            font: { color: tg?.themeParams?.text_color || '#ffffff', size: 12, face: 'Inter' },
            title: primaryRole.toUpperCase(), // basic tooltip
            // Store full data for widget
            customData: item
        });
        nodeMap.set(item.address, true);
    });

    // Add edges from backend
    if (graphData.edges) {
        graphData.edges.forEach(edge => {
            if (nodeMap.has(edge.source) && nodeMap.has(edge.target)) {
                let colorOptions = { color: 'rgba(255,255,255,0.2)', highlight: '#60a5fa' };
                if (edge.type === 'synchronous_entry') {
                    colorOptions = { color: 'rgba(239, 68, 68, 0.4)', highlight: '#ef4444' }; // red for sniper sync
                } else if (edge.type === 'dev_transfer') {
                    colorOptions = { color: 'rgba(139, 92, 246, 0.4)', highlight: '#8b5cf6' }; // purple for dev
                }
                
                edges.push({
                    from: edge.source,
                    to: edge.target,
                    arrows: 'to',
                    color: colorOptions,
                    title: edge.type // tooltip on hover
                });
            }
        });
    }

    const container = document.getElementById('network');
    const data = {
        nodes: new vis.DataSet(nodes),
        edges: new vis.DataSet(edges)
    };

    const options = {
        physics: {
            enabled: true,
            barnesHut: {
                gravitationalConstant: -2000,
                centralGravity: 0.3,
                springLength: 95,
                springConstant: 0.04,
                damping: 0.09,
                avoidOverlap: 0.1
            }
        },
        interaction: {
            hover: true,
            zoomView: true,
            dragView: true
        }
    };

    const network = new vis.Network(container, data, options);

    // Widget interaction
    const widget = document.getElementById('walletWidget');
    const wRole = document.getElementById('widgetRole');
    const wAddr = document.getElementById('widgetAddress');
    const wPct = document.getElementById('widgetPct');
    const wFund = document.getElementById('widgetFunding');

    network.on("selectNode", function (params) {
        if (params.nodes.length > 0) {
            const nodeId = params.nodes[0];
            const nodeData = data.nodes.get(nodeId).customData;
            
            const primaryRole = (nodeData.roles && nodeData.roles.length > 0) ? nodeData.roles[0] : 'holder';
            wRole.innerText = primaryRole.toUpperCase();
            wRole.style.color = roleColors[primaryRole]?.border || '#3b82f6';
            wAddr.innerText = nodeData.address;
            wPct.innerText = nodeData.pct.toFixed(2);
            wFund.innerText = nodeData.fundingSource || 'Нет';
            
            widget.classList.remove('hidden');
        }
    });

    network.on("deselectNode", function () {
        widget.classList.add('hidden');
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
        network.fit({
            animation: { duration: 800, easingFunction: "easeOutQuart" }
        });
    });
});
