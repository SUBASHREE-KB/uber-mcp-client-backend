// src/mcpClient.ts
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import WebSocket from "ws";
import { EventEmitter } from "events";
import dotenv from "dotenv";
dotenv.config();

type RPCRequest = { jsonrpc?: string; id?: string | number; method: string; params?: any };
type RPCResponse = { jsonrpc?: string; id?: string | number; result?: any; error?: any };

// Simple MCP client supporting local spawn (stdio JSON lines) or remote WebSocket JSON-RPC
export class MCPClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ws: WebSocket | null = null;
  private idCounter = 0;
  private pending = new Map<string | number, (resp: RPCResponse) => void>();
  private buffer = "";
  private isReady = false;

  constructor() {
    super();
  }

  // call this to start local mcp-uber via spawn
  async startLocal(cmd = process.env.MCP_LOCAL_CMD || "npx mcp-uber") {
    if (this.child) return;
    
    console.log("[MCP] Starting local MCP process with command:", cmd);
    
    // Parse command and arguments
    const cmdParts = cmd.split(' ');
    const mainCmd = cmdParts[0];
    const args = cmdParts.slice(1);
    
    // Use shell:true to make spawn find npx on Windows
    this.child = spawn(mainCmd, args, { 
      shell: true, 
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        UBER_CLIENT_ID: process.env.UBER_CLIENT_ID,
        UBER_CLIENT_SECRET: process.env.UBER_CLIENT_SECRET,
        UBER_REDIRECT_URI: process.env.UBER_REDIRECT_URI,
        UBER_ENVIRONMENT: process.env.UBER_ENVIRONMENT
      }
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      const data = chunk.toString();
      console.log("[MCP STDOUT]", data);
      this.handleStdoutChunk(data);
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const data = chunk.toString();
      console.log("[MCP STDERR]", data);
      
      // Check if MCP server is ready based on stderr output
      if (data.includes("MCP Uber server started") || data.includes("Server listening")) {
        if (!this.isReady) {
          this.isReady = true;
          console.log("[MCP] Emitting ready event");
          this.emit("ready");
        }
      }
      
      this.emit("stderr", data);
    });

    this.child.on("exit", (code) => {
      console.log("[MCP] child exited with code:", code);
      this.emit("exit", code);
      this.child = null;
      this.isReady = false;
    });

    this.child.on("error", (error) => {
      console.error("[MCP] child process error:", error);
      this.emit("error", error);
    });

    // Give the process some time to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // If not ready yet, try to initialize with the tools/list call
    if (!this.isReady) {
      try {
        console.log("[MCP] Attempting to initialize with tools/list call");
        const response = await this.sendRPC({ method: "tools/list", params: {} });
        console.log("[MCP] Tools list response:", response);
        if (!this.isReady) {
          this.isReady = true;
          this.emit("ready");
        }
      } catch (error) {
        console.error("[MCP] Failed to get tools list:", error);
        // Still emit ready event to prevent blocking
        if (!this.isReady) {
          this.isReady = true;
          this.emit("ready");
        }
      }
    }

    console.log("[MCP] Local MCP process setup complete");
  }

  // connect to remote MCP server using websocket (server must accept JSON-RPC messages)
  async connectRemote(wsUrl: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      console.log("[MCP WS] connected to", wsUrl);
      this.isReady = true;
      this.emit("ready");
    });

    this.ws.on("message", (data) => {
      try {
        const msgStr = typeof data === "string" ? data : data.toString();
        const obj = JSON.parse(msgStr);
        this.handleRpcResponse(obj);
      } catch (e) {
        console.error("[MCP WS] invalid JSON", e);
      }
    });

    this.ws.on("close", () => {
      console.log("[MCP WS] closed");
      this.isReady = false;
      this.emit("close");
      this.ws = null;
    });

    this.ws.on("error", (err) => {
      console.error("[MCP WS] error", err);
      this.emit("error", err);
    });
  }

  private handleStdoutChunk(chunk: string) {
    // MCP may write JSON objects separated by newlines; accumulate and parse by newline
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        console.log("[MCP] Received JSON response:", obj);
        this.handleRpcResponse(obj);
      } catch (err) {
        // Some MCP servers print logs; ignore lines that are not JSON
        // But forward to listeners so devs can inspect
        this.emit("log", line);
      }
    }
  }

  private handleRpcResponse(obj: any) {
    if (obj && (obj.id !== undefined)) {
      const cb = this.pending.get(obj.id);
      if (cb) {
        cb(obj);
        this.pending.delete(obj.id);
      } else {
        // not a awaited RPC; emit as event
        this.emit("event", obj);
      }
    } else {
      // no id -> event or notification
      this.emit("notification", obj);
    }
  }

  private sendRPC(req: RPCRequest): Promise<RPCResponse> {
    return new Promise((resolve, reject) => {
      const id = req.id ?? ++this.idCounter;
      req.jsonrpc = "2.0"; // Add JSON-RPC version
      req.id = id;
      const payload = JSON.stringify(req);

      console.log("[MCP] Sending RPC request:", payload);

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for request ${id}`));
      }, 30000); // 30 second timeout

      this.pending.set(id, (resp) => {
        clearTimeout(timeout);
        console.log("[MCP] Received RPC response:", resp);
        if (resp.error) {
          reject(new Error(`MCP Error: ${JSON.stringify(resp.error)}`));
        } else {
          resolve(resp);
        }
      });

      // local child
      if (this.child && this.child.stdin) {
        try {
          this.child.stdin.write(payload + "\n");
          return;
        } catch (error) {
          console.error("[MCP] Error writing to child stdin:", error);
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(error);
          return;
        }
      }

      // ws
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(payload);
        return;
      }

      this.pending.delete(id);
      clearTimeout(timeout);
      reject(new Error("No MCP connection (neither child nor websocket)"));
    });
  }

  // Check if MCP is ready
  public ready(): boolean {
    return this.isReady;
  }

  // convenience wrappers for known tools - using tools/call method
  async callTool(toolName: string, arguments_: any = {}) {
    const resp = await this.sendRPC({
      method: "tools/call",
      params: {
        name: toolName,
        arguments: arguments_
      }
    });
    return resp;
  }

  async listTools() {
    const resp = await this.sendRPC({ method: "tools/list", params: {} });
    return resp;
  }

  async uber_get_auth_url(params: any = {}) {
    return this.callTool("uber_get_auth_url", params);
  }

  async uber_set_access_token(params: any) {
    return this.callTool("uber_set_access_token", params);
  }

  async uber_get_price_estimates(params: any) {
    return this.callTool("uber_get_price_estimates", params);
  }

  async uber_request_ride(params: any) {
    return this.callTool("uber_request_ride", params);
  }

  async uber_get_ride_status(params: any) {
    return this.callTool("uber_get_ride_status", params);
  }

  async uber_cancel_ride(params: any) {
    return this.callTool("uber_cancel_ride", params);
  }

  // close resources
  close() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isReady = false;
  }
}