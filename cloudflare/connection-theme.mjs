// Shared by the browser connection screens and the server-rendered OAuth result.
export const connectionCss = `
.connection-page{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:32px 20px;background:#000;color:#fff;font-family:SpotifyMixUI,system-ui,sans-serif;line-height:1.55}
.connection-card{width:100%;max-width:480px;padding:32px;border:1px solid #282828;border-radius:12px;background:#121212;box-sizing:border-box}
.connection-content{color:#fff;font-family:SpotifyMixUI,system-ui,sans-serif;line-height:1.55;text-align:left}
.connection-brand{display:flex;align-items:center;gap:10px;margin:0 0 26px;font-size:14px;font-weight:700;color:#b3b3b3}
.connection-mark{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#1ed760;color:#000;font-size:20px;line-height:1}
.connection-heading{margin:0 0 12px;color:#fff!important;font-size:28px;font-weight:700;line-height:1.2;letter-spacing:-.6px;text-wrap:balance}
.connection-description{margin:0 0 22px;color:#b3b3b3;font-size:14px}
.connection-steps{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 22px;font-size:12px;font-weight:600;color:#b3b3b3}
.connection-steps span{border:1px solid #333;border-radius:999px;padding:5px 10px}
.connection-steps .is-active{color:#fff;border-color:#777;background:#242424}
.connection-code{padding:16px;text-align:center;border:1px solid #333;border-radius:8px;background:#1a1a1a;margin:18px 0}
.connection-code-label{display:block;color:#b3b3b3;font-size:12px;margin-bottom:8px}
.connection-code strong{display:block;font-size:28px;line-height:1.2;letter-spacing:4px;font-variant-numeric:tabular-nums;color:#fff}
.connection-qr{display:flex;justify-content:center;margin:24px 0}
.connection-confirm{display:flex;gap:12px;align-items:flex-start;margin:22px 0;font-size:14px;cursor:pointer}
.connection-confirm input{appearance:auto;flex:none;width:18px;height:18px;margin-top:3px;accent-color:#1ed760}
.connection-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 20px;border:0;border-radius:999px;background:#fff;color:#000;font:700 14px SpotifyMixUI,system-ui,sans-serif;line-height:1.4;cursor:pointer;touch-action:manipulation;white-space:nowrap;text-decoration:none;box-sizing:border-box}
.connection-button:hover:not(:disabled){background:#f0f0f0;transform:scale(1.02)}
.connection-button:focus-visible{outline:2px solid #fff;outline-offset:4px}
.connection-button:disabled{opacity:.45;cursor:default}
.connection-button-secondary{background:transparent;color:#fff;border:1px solid #727272}
.connection-button-secondary:hover:not(:disabled){background:#242424;border-color:#fff}
.connection-button-wide{width:100%;font-size:16px;min-height:48px}
.connection-note{color:#b3b3b3;font-size:12px;margin:18px 0 0}
.connection-status{display:flex;align-items:center;gap:8px;color:#b3b3b3;font-size:13px;margin:16px 0 0}
.connection-dot{width:7px;height:7px;flex:none;border-radius:50%;background:#1ed760}
.connection-link{display:flex;align-items:center;gap:10px;margin-top:16px}
.connection-link .ant-typography{min-width:0;flex:1;overflow-wrap:anywhere;color:#b3b3b3!important;font-size:12px;margin:0}
.connection-error{padding:14px;border:1px solid #693b3b;border-radius:8px;color:#ffb4b4;background:#2b1717;font-size:14px;overflow-wrap:anywhere;margin:18px 0}
.connection-success{display:grid;place-items:center;width:56px;height:56px;margin:0 0 22px;border-radius:50%;background:#1ed760;color:#000;font-size:28px;font-weight:700}
.connection-modal.ant-modal{background:#121212!important;border-radius:12px}
.connection-modal.ant-modal .ant-modal-content{background:#121212!important;border:1px solid #282828;border-radius:12px;padding:28px}
.connection-modal.ant-modal .ant-modal-header{background:transparent!important;margin-bottom:20px}
.connection-modal .ant-modal-title{color:#fff;font-size:24px;line-height:1.3}
.connection-modal .ant-modal-close{color:#b3b3b3}
.connection-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
@media(max-width:600px){.player-connection-alert.ant-alert{flex-wrap:wrap;align-items:flex-start}.player-connection-alert .ant-alert-content{flex:1;min-width:0}.player-connection-alert .ant-alert-action{width:100%;margin:12px 0 0;padding-left:26px}}
@media(max-width:480px){.connection-page{padding:20px 14px}.connection-card{padding:24px 20px}.connection-modal .ant-modal-content{padding:24px 20px}.connection-heading{font-size:26px}.connection-button{padding:10px 16px}}
`;
