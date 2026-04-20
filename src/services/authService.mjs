import { supabase } from '../db/supabaseClient.mjs';
import { encrypt, decrypt } from '../utils/encryption.mjs';
import 'dotenv/config'; // Подключаем .env в самом начале (современный синтаксис)

export class AuthService {
  /**
   * Сохраняет или обновляет API ключи пользователя
   * @param {number} telegramId
   * @param {string} apiKey
   * @param {string} apiSecret
   * @returns {Promise<Object>} данные сохранённого пользователя
   */
  async registerUser(telegramId, apiKey, apiSecret) {
    const encryptedApiKey = encrypt(apiKey);
    const encryptedApiSecret = encrypt(apiSecret);

    const { data, error } = await supabase
      .from('users')
      .upsert(
        {
          telegram_id: telegramId,
          encrypted_api_key: encryptedApiKey,
          encrypted_api_secret: encryptedApiSecret,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'telegram_id' }
      )
      .select();

    if (error) throw error;
    return data[0];
  }

  /**
   * Получает расшифрованные API ключи пользователя
   * @param {number} telegramId
   * @returns {Promise<{apiKey: string, apiSecret: string} | null>}
   */
  async getUserKeys(telegramId) {
    console.log(1);
    // const { data, error } = await supabase
    //   .from('users')
    //   .select('encrypted_api_key, encrypted_api_secret')
    //   .eq('telegram_id', telegramId)
    //   .single();

    // if (error) {
    //     console.log(2);
    //   if (error.code === 'PGRST116') return null; // пользователь не найден
    //   throw error;
    // }
    console.log(3);
    
    return {
    //   apiKey: decrypt(data.encrypted_api_key) | process.env.APIKEY,
    //   apiSecret: decrypt(data.encrypted_api_secret) | process.env.APISECRET,
        apiKey:process.env.APIKEY,
        apiSecret:process.env.APISECRET
    };
  }

  /**
   * Проверяет, зарегистрирован ли пользователь
   * @param {number} telegramId
   * @returns {Promise<boolean>}
   */
  async isRegistered(telegramId) {
    const keys = await this.getUserKeys(telegramId);
    return keys !== null;
  }

  /**
   * Удаляет ключи пользователя (например, при отвязке)
   * @param {number} telegramId
   */
  async deleteUser(telegramId) {
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('telegram_id', telegramId);
    if (error) throw error;
  }
}