import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5001;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Support large base64 strings

// Helper: Poll DashScope asynchronous task
async function pollDashScopeTask(taskId) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const url = `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`;

  // Poll up to 20 times (30 seconds total)
  for (let i = 0; i < 20; i++) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Polling task ${taskId} failed: status ${response.status}`);
    }

    const data = await response.json();
    const status = data.output?.task_status;

    if (status === 'SUCCEEDED') {
      const results = data.output?.results;
      const imageUrl = (results && results[0]?.url) || data.output?.image_url;
      if (!imageUrl) throw new Error('Task succeeded but no output image URL was returned.');
      return imageUrl;
    }

    if (status === 'FAILED') {
      throw new Error(`AI generation task failed: ${data.output?.message || 'unknown error'}`);
    }

    // Wait 1.5 seconds
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  throw new Error('AI generation task timed out.');
}

// Helper: Fetch remote image URL and convert to Base64
async function convertUrlToBase64(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to fetch output image: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

// Helper: Ensure base64 string is a valid data URI for Wanx models
function ensureDataUri(base64Image) {
  if (base64Image.startsWith('data:')) {
    return base64Image;
  }
  return `data:image/jpeg;base64,${base64Image}`;
}

// AI Style Transfer (Ghibli, Claymation, Retro Film using Doubao model via Volcano Ark)
app.post('/api/ai/style-transfer', async (req, res) => {
  try {
    const { image, style = 'cartoon' } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image base64 data is required.' });
    }

    const imageDataUri = ensureDataUri(image);
    const volcApiKey = process.env.VOLC_API_KEY;
    const dashscopeApiKey = process.env.DASHSCOPE_API_KEY;

    if (!volcApiKey && !dashscopeApiKey) {
      return res.status(500).json({ error: '服务器未配置 VOLC_API_KEY 或 DASHSCOPE_API_KEY，请联系管理员。' });
    }

    // ===== Primary: Volcano Ark Doubao-Seedream (highest quality style transfer) =====
    if (volcApiKey) {
      console.log(`[StyleTransfer] 使用 Volcano Ark (Doubao Seedream 5.0), style=${style}`);
      
      let prompt = '将参考图转换成极其精美的吉卜力动画风格，宫崎骏工作室手绘画画风，温暖治愈的水彩线条，梦幻柔和的动漫光影，明亮清新的色彩，高清原画品质';
      if (style === 'clay') {
        prompt = '将参考图重新渲染成软萌可爱的3D泥塑黏土人偶玩具风格，黏土橡皮泥材质，温润反光表面，明亮清新的色彩，纯色背景，高分辨率，3d clay illustration';
      } else if (style === 'japanese-film') {
        prompt = '将参考图重新渲染成精美的复古日式胶片风格照片，温暖怀旧的色彩，富士胶片质感，柔和微细颗粒感，自然采光，analog camera photography, Fuji film look, retro warm vintage tones, high quality';
      }

      // Use "2K" to let Seedream auto-adapt aspect ratio instead of forcing square 2048x2048
      const volcPayload = {
        model: 'doubao-seedream-5-0-260128',
        prompt: prompt,
        image: [imageDataUri],
        size: '2K',
        n: 1
      };

      console.log(`[StyleTransfer] Sending to Seedream: model=${volcPayload.model}, prompt length=${prompt.length}`);

      const volcResponse = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${volcApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(volcPayload)
      });

      if (volcResponse.ok) {
        const volcData = await volcResponse.json();
        const resultUrl = volcData.data?.[0]?.url;
        if (resultUrl) {
          console.log('[StyleTransfer] ✅ Seedream 生成成功，正在转换为 base64...');
          const resultBase64 = await convertUrlToBase64(resultUrl);
          return res.json({ image: resultBase64, model: 'doubao-seedream-5-0' });
        } else {
          console.error('[StyleTransfer] ⚠️ Seedream returned OK but no image URL:', JSON.stringify(volcData));
          throw new Error('Seedream 返回成功但未包含图片，请重试。');
        }
      } else {
        const errText = await volcResponse.text();
        console.error(`[StyleTransfer] ❌ Seedream API 调用失败 (HTTP ${volcResponse.status}): ${errText}`);
        
        if (!dashscopeApiKey) {
          throw new Error(`Seedream 风格化失败 (HTTP ${volcResponse.status})，请检查火山引擎账户余额或 API Key 是否有效。`);
        }
        console.warn('[StyleTransfer] ⚠️ Seedream 失败，降级使用 DashScope 万相模型（画质可能降低）');
      }
    }

    // ===== Fallback: DashScope (Wanx) — only if Volcano is not configured or failed =====
    if (!dashscopeApiKey) {
      throw new Error('所有图像生成服务均不可用，请联系管理员配置 API Key。');
    }

    console.log(`[StyleTransfer] 使用备用引擎 DashScope (Wanx), style=${style}`);
    const imageeditUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis';
    const reprintUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation';
    
    let dashscopePrompt = '转换成吉卜力动画风格，宫崎骏工作室风格，柔和水彩质感，温暖明亮的色调，细腻的手绘线条，梦幻唯美的动漫画风';
    if (style === 'clay') {
      dashscopePrompt = '重新渲染成软萌可爱的3D泥塑黏土人偶玩具风格，黏土橡皮泥材质，温润反光表面，明亮清新的色彩，纯色背景，3d clay illustration';
    } else if (style === 'japanese-film') {
      dashscopePrompt = '重新渲染成精美的复古日式胶片风格照片，温暖怀旧的色彩，富士胶片质感，柔和微细颗粒感，自然采光，Fuji film look, retro warm vintage tones';
    }

    let payload = {
      model: 'wanx2.1-imageedit',
      input: {
        base_image_url: imageDataUri,
        function: 'stylization_all',
        prompt: dashscopePrompt
      },
      parameters: {
        n: 1
      }
    };

    console.log(`[StyleTransfer] 尝试 wanx2.1-imageedit (stylization_all)...`);
    let taskResponse = await fetch(imageeditUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${dashscopeApiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      },
      body: JSON.stringify(payload)
    });

    if (!taskResponse.ok) {
      const errText = await taskResponse.text();
      console.warn(`[StyleTransfer] wanx2.1-imageedit failed: ${errText}. Trying wanx-style-repaint-v1 (3D童话)...`);
      
      payload = {
        model: 'wanx-style-repaint-v1',
        input: {
          image_url: imageDataUri,
          style_index: 1 // 1: 3D童话
        }
      };

      taskResponse = await fetch(reprintUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dashscopeApiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        body: JSON.stringify(payload)
      });
    }

    if (!taskResponse.ok) {
      const errText = await taskResponse.text();
      console.warn(`[StyleTransfer] wanx-style-repaint-v1 3D童话 failed: ${errText}. Trying style_index 7 (炫彩卡通)...`);
      payload = {
        model: 'wanx-style-repaint-v1',
        input: {
          image_url: imageDataUri,
          style_index: 7 // 7: 炫彩卡通
        }
      };

      taskResponse = await fetch(reprintUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dashscopeApiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        body: JSON.stringify(payload)
      });
    }

    if (!taskResponse.ok) {
      const errText = await taskResponse.text();
      throw new Error(`所有风格化引擎均失败: ${taskResponse.status} - ${errText}`);
    }

    const taskData = await taskResponse.json();
    const taskId = taskData.output?.task_id || taskData.task_id || taskData.id;
    if (!taskId) throw new Error(`No task ID returned. Response: ${JSON.stringify(taskData)}`);

    // Poll for result
    const resultUrl = await pollDashScopeTask(taskId);
    // Convert output image back to base64
    const resultBase64 = await convertUrlToBase64(resultUrl);

    res.json({ image: resultBase64, model: 'dashscope-wanx' });
  } catch (error) {
    console.error('[StyleTransfer] ❌ Error:', error);
    res.status(500).json({ error: `风格化失败: ${error.message}` });
  }
});

// AI Copywriting Generator
app.post('/api/ai/generate-copy', async (req, res) => {
  try {
    const { style = '探店', keywords = '' } = req.body;

    const volcKey = process.env.VOLC_API_KEY;
    if (!volcKey) {
      return res.status(500).json({ error: 'Volcano Ark Key is not configured on the server.' });
    }

    let promptStyleGuidance = '';
    if (style === '探店') {
      promptStyleGuidance = `这三款文案均应围绕【探店】风格进行创作，但侧重点不同：
- 选项一的 styleName 为 “强力种草”：语气兴奋、极具煽动性，突出探店的特色亮点、招牌特色及消费体验。
- 选项二的 styleName 为 “真实体验”：客观细致，从消费者的第一视角，介绍店内的环境、氛围、服务品质和性价比。
- 选项三的 styleName 为 “避坑与打卡”：精简吸睛，告诉读者哪里拍照最出片，有哪些拍照姿势和探店避坑小建议。`;
    } else if (style === '旅行心情') {
      promptStyleGuidance = `这三款文案均应围绕【旅行心情】风格进行创作，但侧重点不同：
- 选项一的 styleName 为 “文艺治愈”：慢节奏、有故事感和温馨气息，探讨旅行中的偶遇、风景与内心的平静。
- 选项二的 styleName 为 “碎碎念记录”：活泼轻快，记录旅途中的趣味瞬间、突发小状况或真实的旅行状态。
- 选项三的 styleName 为 “金句共鸣”：文笔简练高级，探讨旅行的意义，产出容易引起小红书读者互动和收藏的金句。`;
    } else {
      promptStyleGuidance = `这三款文案均应围绕用户设定的自定义风格【${style}】进行创作，但侧重点不同：
- 选项一的 styleName 为 “热情分享”：语气亲切、带有情绪价值，重点介绍相关亮点和核心体验。
- 选项二的 styleName 为 “深度测评”：偏向详细测评、利弊分析或细节描述，有深度和实用性。
- 选项三的 styleName 为 “吸睛亮点”：精练高级，突出重点与反差感，适合快节奏阅读，包含醒目小标题。`;
    }

    let keywordsPrompt = '';
    if (keywords && keywords.trim() !== '') {
      keywordsPrompt = `用户提供的主题/关键词为：“${keywords.trim()}”。请紧密结合这些关键词和主题进行内容创作。`;
    } else {
      keywordsPrompt = `用户未提供具体的关键词，请基于该风格的特点创作一个通用的、具有代表性的小红书爆款模板内容。`;
    }

    console.log(`Generating Xiaohongshu copy for style [${style}] and keywords [${keywords}] using Volcano...`);
    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${volcKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-260425',
        messages: [
          {
            role: 'user',
            content: `你是一个小红书运营大师与视觉策划博主。请根据用户选择的风格和给出的关键词，为用户生成3款不同情感路线的小红书爆款文案。每一款文案必须包含：
1. 【爆款标题】（包含吸睛的Emoji，字数在20字以内）
2. 【笔记正文】（包含Emoji排版，空行，内容活泼，适合社交分享，字数在150字左右）
3. 【推荐话题标签】（例如 #日常碎片 #我的日常）

这三款文案的风格要求如下：
${promptStyleGuidance}

${keywordsPrompt}

请直接输出规范的 JSON 格式数据，以便系统直接解析，结构如下：
{
  "options": [
    {
      "styleName": "选项一的 styleName，如：强力种草",
      "title": "标题...",
      "body": "正文内容...",
      "tags": "#标签1 #标签2"
    },
    ...
  ]
}
不要输出任何 Markdown 格式包裹（如 \`\`\`json 标记），不要输出任何解释性话语，直接返回纯 JSON 对象。`
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Volcano API failed: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('Empty response from Volcano model.');
    }

    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '').trim();
    }

    try {
      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch (parseErr) {
      console.warn('JSON parsing failed, returning raw text. Text was:', text);
      res.json({
        options: [
          {
            styleName: '智能生成文案',
            title: '日常小美好 ✨',
            body: text,
            tags: '#日常碎片 #AI生活记录'
          }
        ]
      });
    }
  } catch (error) {
    console.error('Copy generation error:', error);
    res.status(500).json({ error: `文案生成失败: ${error.message}` });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    dashscopeConfigured: !!process.env.DASHSCOPE_API_KEY,
    volcConfigured: !!process.env.VOLC_API_KEY
  });
});

// Serve static files from React build folder in production
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// For all other requests, return index.html (client-side routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// Start Server
app.listen(port, () => {
  console.log(`Xiaohongshu Generator backend listening at http://localhost:${port}`);
  console.log(`API Health Check: http://localhost:${port}/api/health`);
});
