import { config } from '../config';
import { Client, MessageAttachment, MessageEmbed, TextChannel } from "discord.js";
import { Routes } from "discord-api-types/v10";
import { REST } from "@discordjs/rest";

const discordCommands = []
let inited = false

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

  init() {
    if (!process.env.DISCORD_TOKEN) return;
    this.client = new Client({ intents: ['GUILD_MEMBERS'] });
    this.client.once('ready', async (c) => {
      const channels = config.discord_channels.split(',');
      for (let channel of channels)
        this.channels.push(
          (await this.client.channels.fetch(channel)) as TextChannel,
        );
    });
    if (!inited) {
      inited = true
      this.client.login(process.env.DISCORD_TOKEN);

      setTimeout(async () => {
        const rest = new REST().setToken(process.env.DISCORD_TOKEN);
      
        const guildIds = config.discord_guild_ids.split(',')
    
        guildIds.forEach(async (guildId) => {
          await rest.put(
            Routes.applicationGuildCommands(config.discord_client_id, guildId),
            { body: discordCommands },
          );    
        })
      }, 2000)      
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
