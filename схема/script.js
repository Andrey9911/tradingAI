document.addEventListener("DOMContentLoaded", function () {
    const container = document.getElementById('network');

    const options = {
        nodes: {
            shape: 'box',
            margin: 16,
            borderWidth: 2,
            shadow: {
                enabled: true,
                color: 'rgba(0,0,0,0.5)',
                size: 10,
                x: 0,
                y: 4
            },
            font: {
                face: 'Inter',
                size: 16,
                color: '#ffffff',
                bold: {
                    color: '#ffffff',
                    size: 16,
                    vadjust: 0,
                    mod: 'bold'
                }
            }
        },
        edges: {
            width: 2,
            shadow: true,
            smooth: {
                type: 'cubicBezier',
                forceDirection: 'vertical',
                roundness: 0.4
            },
            arrows: {
                to: { enabled: true, scaleFactor: 0.7 }
            },
            color: {
                color: 'rgba(255,255,255,0.15)',
                highlight: '#60a5fa',
                hover: '#a78bfa'
            },
            font: {
                color: '#94a3b8',
                size: 12,
                face: 'Inter',
                background: 'rgba(11, 15, 25, 0.8)',
                strokeWidth: 0
            }
        },
        groups: {
            client: {
                color: { background: '#1e3a8a', border: '#3b82f6', highlight: { background: '#2563eb', border: '#60a5fa' } }
            },
            logic: {
                color: { background: '#4c1d95', border: '#8b5cf6', highlight: { background: '#6d28d9', border: '#a78bfa' } }
            },
            external: {
                color: { background: '#064e3b', border: '#10b981', highlight: { background: '#047857', border: '#34d399' } }
            }
        },
        layout: {
            hierarchical: {
                direction: 'UD', 
                sortMethod: 'directed',
                nodeSpacing: 220,
                levelSeparation: 150,
                shakeTowards: 'roots'
            }
        },
        physics: {
            enabled: true,
            hierarchicalRepulsion: {
                centralGravity: 0.0,
                springLength: 150,
                springConstant: 0.01,
                nodeDistance: 220,
                damping: 0.09
            },
            solver: 'hierarchicalRepulsion'
        },
        interaction: {
            hover: true,
            tooltipDelay: 200,
            zoomView: true,
            dragView: true,
            dragNodes: true
        }
    };

    const data = {
        nodes: new vis.DataSet(projectSchema.nodes),
        edges: new vis.DataSet(projectSchema.edges)
    };

    const network = new vis.Network(container, data, options);

    // Disable physics after stabilization so nodes stay exactly where dragged
    network.once("stabilizationIterationsDone", function () {
        network.setOptions({ physics: false });
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
        network.fit({
            animation: {
                duration: 800,
                easingFunction: "easeOutQuart"
            }
        });
    });
});
