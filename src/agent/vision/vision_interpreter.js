import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
import fs from 'fs';
import { resolvePlayerName } from '../library/skills.js';

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        this.camera_disabled = false;
        if (allow_vision) {
            try {
                this.camera = new Camera(agent.bot, this.fp, 3000 + (agent.count_id || 0));
                this.camera.on('error', (err) => {
                    console.warn('Camera error:', err.message);
                    this.camera_disabled = true;
                });
            } catch (err) {
                console.warn('Failed to initialize camera:', err.message);
                this.camera_disabled = true;
            }
        }
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest || this.camera_disabled) {
            return "Vision is disabled. Camera/rendering not available in headless Docker environment. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        
        // Resolve player name with fuzzy matching
        const resolvedName = resolvePlayerName(bot, player_name);
        if (!resolvedName) {
            return `Could not find player "${player_name}". Nearby players: ${Object.keys(bot.players).filter(n => n !== bot.username).join(', ') || 'none'}`;
        }
        player_name = resolvedName;
        
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        try {
            if (direction === 'with') {
                await bot.look(player.yaw, player.pitch);
                result = `Looking in the same direction as ${player_name}\n`;
                filename = await this.camera.capture();
            } else {
                await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
                result = `Looking at player ${player_name}\n`;
                filename = await this.camera.capture();
            }
            return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
        } catch (err) {
            return `Vision error: ${err.message}. Use other methods to describe the environment.`;
        }
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest || this.camera_disabled) {
            return "Vision is disabled. Camera/rendering not available in headless Docker environment. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        try {
            await bot.lookAt(new Vec3(x, y + 2, z));
            result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

            let filename = await this.camera.capture();

            return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
        } catch (err) {
            return `Vision error: ${err.message}. Use other methods to describe the environment.`;
        }
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            return result + `\n${blockInfo}`;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }
} 