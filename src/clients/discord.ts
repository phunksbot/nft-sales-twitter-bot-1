import { config } from '../config';
import { Client, MessageAttachment, MessageEmbed, TextChannel } from "discord.js";
import { Routes } from "discord-api-types/v10";
import { REST } from "@discordjs/rest";

const discordCommands = []
let inited = false
const callbacks: Function[] = []
const interactionsListener:any[] = [];

export default class DiscordClient {
  
  getDiscordCommands() {
    return discordCommands
  }
  
  channels: TextChannel[] = [];
  setup: boolean;
  client: Client;

  getClient():Client {
    return this.client
  }

  getInteractionsListener() {
    return interactionsListener
  }

  init(callback:Function=undefined) {
    if (!process.env.DISCORD_TOKEN) return;
    this.client = new Client({ intents: ['GUILD_MESSAGE_REACTIONS', 'GUILD_MEMBERS', 'MESSAGE_CONTENT'] });
    this.client.once('ready', async (c) => {
      const channels = config.discord_channels.split(',');
      for (let channel of channels)
        this.channels.push(
          (await this.client.channels.fetch(channel)) as TextChannel,
        );
      const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    
      const guildIds = config.discord_guild_ids.split(',')
  
      if (callback) callback()
      if (callbacks.length) callbacks.forEach(c => c())

      this.client.on('interactionCreate', (interaction) => {
        for (const listener of interactionsListener) {
          listener(interaction)
        }
      })
      guildIds.forEach(async (guildId) => {
        await rest.put(
          Routes.applicationGuildCommands(config.discord_client_id, guildId),
          { body: discordCommands },
        );    
      })              
    });
    if (!inited) {
      inited = true
      this.client.login(process.env.DISCORD_TOKEN);
    } else {
      if (callback !== undefined) callbacks.push(callback)
    }
    this.setup = true;
  }


  async sendEmbed(embed:MessageEmbed, image:string|Buffer, platform:string) {
    this.channels.forEach(async (channel) => {
      await channel.send({
        embeds: [embed],
        files: [
          { attachment: image, name: 'token.png' },
          { attachment: platform, name: 'platform.png' },
        ],
      });
    });
  }

  async send(text: string, images: string[]) {
    this.channels.forEach(async (channel) => {
      await channel.send({
        content: text,
        files: images,
      });
    });
  }
}
