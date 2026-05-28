import { supabaseAdmin } from '@/lib/db';
import { type FlowState, emptyFlowState } from './state';

/**
 * Lee el flow_state actual del chat. Si no existe, devuelve estado vacío.
 */
export async function loadFlowState(chatId: string): Promise<FlowState> {
  const { data, error } = await supabaseAdmin()
    .from('chats')
    .select('flow_state')
    .eq('id', chatId)
    .single();
  if (error) throw error;
  const state = data?.flow_state as FlowState | null;
  return state ?? emptyFlowState();
}

export async function saveFlowState(chatId: string, state: FlowState): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('chats')
    .update({
      flow_state: state as never,
      flow_updated_at: new Date().toISOString(),
    })
    .eq('id', chatId);
  if (error) throw error;
}

export async function resetFlowState(chatId: string): Promise<void> {
  await saveFlowState(chatId, emptyFlowState());
}
