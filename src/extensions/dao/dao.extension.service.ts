import { SlashCommandBuilder } from '@discordjs/builders';
import { HttpService } from '@nestjs/axios';
import { Injectable } from "@nestjs/common";
import { BaseService } from "src/base.service";
import { createLogger } from "src/logging.utils";
import Database from 'better-sqlite3'
import { REST } from '@discordjs/rest';
import { config } from '../../config';
import { Routes } from 'discord-api-types/v9'
import { ethers } from 'ethers';
import { BindRequestDto } from './models';
import { SignatureError } from './errors';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { StatisticsService } from '../statistics.extension.service';
import { ModuleRef } from '@nestjs/core';
import { providers } from 'src/app.module';
import { GuildMember, TextBasedChannel } from 'discord.js';
import { format } from 'date-fns';
import { unique } from 'src/utils/array.utils';
import { decrypt, encrypt } from './crypto';

const logger = createLogger('dao.extension.service')

@Injectable()
export class DAOService extends BaseService {
  
  provider = this.getWeb3Provider();
  db = new Database(`${process.env.WORK_DIRECTORY || './'}dao.db.db` /*, { verbose: logger.info } */);  
  insert: any;
  positionCheck: any;
  positionUpdate: any;
  currentBlock: number;
  encryptionKeys: Map<string, string> = new Map<string,string>();

  constructor(
    protected readonly http: HttpService,
    private readonly moduleRef: ModuleRef
  ) {
    super(http)
    logger.info('created DAOService')
    
    this.discordClient.init(() => {
      this.registerCommands()
      this.start()

      if (config.dao_roles.length) {
        setTimeout(() => this.grantRoles(), 10000)
      }
    })
  }

  async start() {

    if (config.dao_requires_encryption_key) {
      const guildsId = unique(config.dao_roles.map(r => r.guildId))
      for (const guildId of guildsId) {
        console.log(`fetching encryption key for ${guildId}`)
        
        const guild = this.discordClient.client.guilds.cache.get(guildId)
        const channels = await guild.channels.fetch()

        const channel = channels.find(channel => channel.name === 'setup-daoextension') as TextBasedChannel
        const lastMessage = await channel.messages.fetch(channel.lastMessageId)
        this.encryptionKeys.set(guildId, lastMessage.content)
        console.log(`fetched encryption key for ${guildId}`)
      }
    }
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id text NOT NULL,
        discord_username text NOT NULL,
        web3_public_key text NOT NULL UNIQUE
      );`,
    ).run();
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS grace_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_guild_id text NOT NULL,
        discord_user_id text NOT NULL,
        discord_role_id text NOT NULL,
        until text NOT NULL
      );`,
    ).run();
  }

  async bounded(username:string) {

  }

  async grantRoles() {
    if (providers.indexOf(StatisticsService)) {
      logger.info(`grantRoles()`)
      const statisticsService = this.moduleRef.get(StatisticsService);

      for (let conf of config.dao_roles) {
        const guild = await this.discordClient.client.guilds.fetch(conf.guildId)
        const role = await guild.roles.fetch(conf.roleId)
        const members = await guild.members.fetch({ force: true })
        for (const m of members) {
          const member = m[1]
          const users = this.getUsersByDiscordUserId(member.id.toString())
          if (users.length) {
            let conditionSucceeded = false
            if (conf.minOwnedCount) {
              const owned = await statisticsService.getOwnedTokens(users.map(u => u.web3_public_key))
              conditionSucceeded = owned.length >= conf.minOwnedCount
            } else if (conf.minted) {
              const numberMinted = await statisticsService.getMintedTokens(users.map(u => u.web3_public_key))
              conditionSucceeded = numberMinted.length > 0
            }
            
            if (conditionSucceeded && !conf.disallowAll) {
              await member.roles.add(role)  
            } else {
              if (member.roles.cache.some(r => r.id === role.id)) {
                if (conf.gracePeriod) {
                  const existingGracePeriod = this.hasGracePeriod(conf.guildId, member.id, conf.roleId)
                  if (!existingGracePeriod) {
                    const endAt = format(new Date().getTime() + conf.gracePeriod*1000, "yyyy-MM-dd'T'HH:mm:ss'Z'")
                    this.setGracePeriod(conf.guildId, member.id, conf.roleId, endAt)
                  }
                } else {
                  if (conf.gracePeriod) {
                    this.removeGracePeriod(conf.guildId, member.id, conf.roleId)
                  }
                  await member.roles.remove(role)
                }
              }
            }
          } else {
            await member.roles.remove(role)
          }
        }

        await this.handleGracePeriods()
        setTimeout(() => this.grantRoles(), 60000*30)
      }
    }
    /*
    guilds.roles.cache.find(role => role.name === "role name");
    member.roles.add(role);
    */
    
  }
  async bindAccount(request: BindRequestDto) {

    // TODO check discord account
    const { data } = await firstValueFrom(this.http.get('https://discord.com/api/users/@me', {
      headers: {
        authorization: `Bearer ${request.discordAccessToken}`,
      }
    }).pipe(
      catchError((error: AxiosError) => {
        logger.error(error)
        throw 'An error happened!';
      }),
    ))
    if (data.id != request.discordUserId) {
      throw new SignatureError('invalid discord user id')
    }
    const signerAddr = await ethers.verifyMessage('This signature is safe and will bind your wallet to your discord user ID.', request.signature);
    if (signerAddr.toLowerCase() !== request.account.toLowerCase()) {
      throw new SignatureError('invalid signature')
    }
    
    // encrypt datas
    if (config.dao_requires_encryption_key) {
      // TODO handle guild id
      const key = this.encryptionKeys.values().next().value
      request.account = encrypt(request.account, key)
      request.discordUsername = encrypt(request.discordUsername, key)
      request.discordUserId = encrypt(request.discordUserId, key)
    }

    console.log('request', request)

    const stmt = this.db.prepare(`
      INSERT INTO accounts (discord_user_id, discord_username, web3_public_key)
      VALUES (@discordUserId, @discordUsername, @account)
      ON CONFLICT(web3_public_key) DO UPDATE SET discord_user_id = excluded.discord_user_id, discord_username = excluded.discord_username
    `)
    stmt.run(request)
  }

  hasGracePeriod(guildId: string, userId: string, roleId: string) {
    const stmt = this.db.prepare(`
      SELECT * FROM grace_periods
      WHERE discord_guild_id = @guildId AND
      discord_user_id = @userId AND
      discord_role_id = @roleId
    `)    
    return stmt.get({
      guildId, userId, roleId
    })
  }

  async handleGracePeriods() {
    const stmt = this.db.prepare(`
      SELECT * FROM grace_periods
      WHERE until < datetime()
    `)  
    const all = stmt.all()
    for (const row of all) {
      console.log(row)
      const guild = await this.discordClient.client.guilds.fetch(row.discord_guild_id)
      const member = await guild.members.cache.get(row.discord_user_id)
      const role = await guild.roles.cache.get(row.discord_role_id)
      member.roles.remove(role)
      this.removeGracePeriod(row.discord_guild_id, row.discord_user_id, row.discord_role_id)
    }
    logger.info('cleaned grace periods')
  }

  removeGracePeriod(guildId: string, userId: string, roleId: string) {
    const stmt = this.db.prepare(`
      DELETE FROM grace_periods 
      WHERE discord_guild_id = @guildId AND
      discord_user_id = @userId AND
      discord_role_id = @roleId
    `)    
    stmt.run({
      guildId, userId, roleId
    })
  }

  setGracePeriod(guildId:string, userId:string, roleId:string, until:string) {
    const stmt = this.db.prepare(`
      INSERT INTO grace_periods (discord_guild_id, discord_user_id, discord_role_id, until)
      VALUES (@guildId, @userId, @roleId, @until)
    `)    
    stmt.run({
      guildId, userId, roleId, until
    })
  }

  async registerCommands() {
    
    const bind = new SlashCommandBuilder()
      .setName('bind')
      .setDescription('Bind your web3 wallet to your discord account')
    
    const bounded = new SlashCommandBuilder()
      .setName('bounded')
      .setDescription('Show the currently web3 wallet bounded to your discord account')

    const commands = [
      bind.toJSON(),
      bounded.toJSON()
    ]
    this.getDiscordCommands().push(...commands)

    const listener = async (interaction) => {
      try {
        if (!interaction.isCommand()) return;
        if ('bind' === interaction.commandName) {
          await interaction.deferReply()
          if (config.dao_requires_encryption_key && !this.encryptionKeys.has(interaction.guildId)) {
            interaction.editReply(`Please ask the admin to setup the encryption key first`)
          }          
          interaction.editReply(`Click here to bind your wallet: http://${config.daoModuleListenAddress}/`)
        } else if ('bounded' === interaction.commandName) {
          await interaction.deferReply()
          const users = this.getUsersByDiscordUserId(interaction.user.id.toString())
          if (users.length) {
            let response = `Currently bound web3 wallet(s): \n`
            response += '```'
            for (const u of users) response += `${u.web3_public_key} \n`
            response += '```\n'
            interaction.editReply(response)
          }
          else 
            interaction.editReply(`No wallet bounded yet.`)
        }
      } catch (err) {
        logger.info(err)
      }
    }
    this.getDiscordInteractionsListeners().push(listener)
  }
  getUsersByDiscordUserId(id: string) {
    if (config.dao_requires_encryption_key) {
      // TODO handle guild id
      const key = this.encryptionKeys.values().next().value
      id = encrypt(id, key)
    }
    const rows = this.db.prepare(`
      SELECT * FROM accounts WHERE discord_user_id = @id
    `).all({id})
    if (config.dao_requires_encryption_key) {
      // TODO handle guild id
      const key = this.encryptionKeys.values().next().value
      for (const row of rows) {
        row.discord_user_id = decrypt(row.discord_user_id, key)
        row.discord_username = decrypt(row.discord_username, key)
        row.web3_public_key = decrypt(row.web3_public_key, key)
      }
    }
    return rows
  }
  getUserByWeb3Wallet(wallet: string) {
    if (config.dao_requires_encryption_key) {
      // TODO handle guild id
      const key = this.encryptionKeys.values().next().value
      wallet = encrypt(wallet.toLowerCase(), key)
    }    
    
    const row = this.db.prepare(`
      SELECT * FROM accounts WHERE lower(web3_public_key) = lower(@wallet)
    `).get({wallet})

    // TODO handle guild id
    if (config.dao_requires_encryption_key && row) {
      const key = this.encryptionKeys.values().next().value
      row.discord_user_id = decrypt(row.discord_user_id, key)
      row.discord_username = decrypt(row.discord_username, key)
      row.web3_public_key = decrypt(row.web3_public_key, key)
    }
    return row
  }

}