type BotsConversation = Conversation & { surface: 'bots' };
type BotsGroupConversation = BotsConversation & { botKind: 'group' };
interface BotMentionResult { everyone: boolean; user: boolean; handles: string[]; botIds: string[] }
interface BotPingOptions { fromBotId?: string | null; replyToSpeakerId?: string | null }
interface OutboundItem { fromBotId?: string; alreadyPosted?: boolean }
interface LoopModelPickerOptions { ariaLabel?: string; className?: string; hiddenClass?: string; onPick?: (value: string) => void }
interface BotSessionOptions { group?: boolean; title?: string; participantIds?: string[]; loopAgents?: Bot[] }
interface BotApiMessage { role: ConversationRole; content: string | ApiContentPart[] }
