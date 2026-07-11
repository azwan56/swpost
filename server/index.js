import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import ExifReader from 'exifreader';
import piexif from 'piexifjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();
// Fallback if started from parent/root folder
if (!process.env.DASHSCOPE_API_KEY) {
  dotenv.config({ path: path.join(__dirname, '.env') });
}

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

// Helper: Extract Date, Time, Location, Device from EXIF data (supports Base64 images)
function extractExif(imageBase64) {
  if (!imageBase64) return null;
  try {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const tags = ExifReader.load(buffer);
    
    // Date/Time
    const dateTime = tags['DateTimeOriginal'] ? tags['DateTimeOriginal'].description : (tags['DateTime'] ? tags['DateTime'].description : null);
    
    // GPS Coordinates
    let gps = null;
    if (tags['GPSLatitude'] && tags['GPSLongitude']) {
      const lat = tags['GPSLatitude'].description;
      const lon = tags['GPSLongitude'].description;
      const latRef = tags['GPSLatitudeRef'] ? tags['GPSLatitudeRef'].description : '';
      const lonRef = tags['GPSLongitudeRef'] ? tags['GPSLongitudeRef'].description : '';
      gps = {
        lat,
        lon,
        latRef,
        lonRef
      };
    }
    
    // Device/Camera model
    const device = tags['Model'] ? tags['Model'].description : (tags['Make'] ? tags['Make'].description : null);

    return {
      dateTime,
      gps,
      device
    };
  } catch (err) {
    return null;
  }
}

// Helper: Copy EXIF headers from original image to styled image, adding custom style/model/brand tag markers
// NOTE: piexifjs only works with JPEG. AI models (Seedream, Wanx) return PNG images.
// For PNG outputs, we skip binary EXIF injection here — the client handles it via the structured exif object.
function copyAndModifyExif(originalBase64, styledBase64, styleName, modelName) {
  try {
    // Detect if styled image is PNG (piexifjs cannot inject EXIF into PNG)
    const styledMimeMatch = styledBase64.match(/^data:(image\/\w+);base64,/);
    const styledMime = styledMimeMatch ? styledMimeMatch[1] : 'image/jpeg';
    
    if (styledMime === 'image/png') {
      console.log('[EXIF] Styled image is PNG — skipping server-side EXIF injection (client will handle it).');
      return styledBase64;
    }

    const originalClean = originalBase64.replace(/^data:image\/\w+;base64,/, "");
    const styledClean = styledBase64.replace(/^data:image\/\w+;base64,/, "");

    const originalBinary = Buffer.from(originalClean, 'base64').toString('binary');
    const styledBinary = Buffer.from(styledClean, 'base64').toString('binary');

    // Check if styled binary is actually JPEG (starts with 0xFF 0xD8)
    if (styledBinary.charCodeAt(0) !== 0xFF || styledBinary.charCodeAt(1) !== 0xD8) {
      console.log('[EXIF] Styled image binary is not JPEG — skipping EXIF injection.');
      return styledBase64;
    }

    // Load EXIF from original
    let exifObj = { "0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": null };
    try {
      exifObj = piexif.load(originalBinary);
    } catch (e) {
      console.log('[EXIF] No original EXIF to copy, creating default.');
    }

    // Convert style names to English ASCII to prevent unicode serialization issues in some EXIF readers
    const styleLabelEn = styleName === 'clay' ? 'Claymation' : styleName === 'japanese-film' ? 'Japanese Retro Film' : styleName === 'polaroid' ? 'Polaroid' : 'Ghibli Anime';

    // Write custom tags/markers in English ASCII
    exifObj["0th"][piexif.ImageIFD.Software] = "Shantie AI - Photo to Copywriter";
    
    const commentText = `Style: ${styleLabelEn}, Model: ${modelName}, Software: ShantieAI`;
    exifObj["Exif"][piexif.ExifIFD.UserComment] = commentText;

    // Dump and insert into styled image
    const exifBytes = piexif.dump(exifObj);
    const newBinary = piexif.insert(exifBytes, styledBinary);

    // Convert back to Base64
    const newBase64 = Buffer.from(newBinary, 'binary').toString('base64');
    
    return `data:${styledMime};base64,${newBase64}`;
  } catch (err) {
    console.error('[EXIF Write] Failed to copy EXIF:', err.message);
    return styledBase64;
  }
}

// Helper: Analyze image content, text, people, and atmosphere using Qwen-VL-Plus
async function analyzeImageMultimodal(imageBase64, apiKey) {
  if (!imageBase64 || !apiKey) return null;
  try {
    const dataUri = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
    
    // Add a 6-second timeout using AbortController to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-vl-plus',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '请仔细观察这张图片，提取并用一段话概括以下信息用于撰写社交媒体文案：\n1. 画面内容与具体场景（如物品、食物、背景等）\n2. 画面中能够识别出的所有文字或牌匾招牌信息\n3. 画面中的人物（如有，描述其数量、着装、神态或动作）\n4. 画面整体营造出的情感氛围与色彩色调（如温馨、热烈、孤独、复古、冷色调等）。\n请直接用150字以内输出描述，不要输出任何引言或解释。'
              },
              {
                type: 'image_url',
                image_url: {
                  url: dataUri
                }
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.warn('[VL Analysis] Failed to analyze image:', response.status, errText);
      return null;
    }

    const resData = await response.json();
    const description = resData.choices?.[0]?.message?.content?.trim();
    console.log('[VL Analysis] Image analysis results:', description);
    return description;
  } catch (err) {
    console.warn('[VL Analysis] Qwen-VL error:', err.message);
    return null;
  }
}

// AI Style Transfer (Ghibli, Claymation, Retro Film using Doubao model via Volcano Ark)
app.post('/api/ai/style-transfer', async (req, res) => {
  try {
    const { image, style = 'cartoon', width, height } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image base64 data is required.' });
    }

    const exifData = extractExif(image);
    const imageDataUri = ensureDataUri(image);
    const volcApiKey = process.env.VOLC_API_KEY;
    const dashscopeApiKey = process.env.DASHSCOPE_API_KEY;

    if (!volcApiKey && !dashscopeApiKey) {
      return res.status(500).json({ error: '服务器未配置 VOLC_API_KEY 或 DASHSCOPE_API_KEY，请联系管理员。' });
    }

    // ===== Primary: Volcano Ark Doubao-Seedream (highest quality style transfer) =====
    if (volcApiKey) {
      console.log(`[StyleTransfer] 使用 Volcano Ark (Doubao Seedream 5.0), style=${style}, original width=${width}, height=${height}`);
      
      let size = '2048x2048'; // Default fallback (4M pixels, compatible with Seedream 5.0)
      if (width && height) {
        let w = parseInt(width, 10);
        let h = parseInt(height, 10);
        if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
          const ratio = w / h;
          const minPixels = 3686400; // Required minimum pixels for Seedream 5.0
          
          // Calculate w and h maintaining aspect ratio with at least minPixels area
          let targetW = Math.sqrt(minPixels * ratio);
          let targetH = targetW / ratio;
          
          // Round to nearest multiple of 16 for network efficiency
          w = Math.round(targetW / 16) * 16;
          h = Math.round(targetH / 16) * 16;
          
          // Ensure we don't fall below minPixels due to rounding down
          while (w * h < minPixels) {
            if (ratio > 1) {
              w += 16;
            } else {
              h += 16;
            }
          }
          
          size = `${w}x${h}`;
          console.log(`[StyleTransfer] Calculated aspect-ratio size for Seedream: ${size} (Total pixels: ${w * h})`);
        }
      }

      let prompt = '将参考图转换成极其精美的吉卜力动画风格，宫崎骏工作室手绘画画风，温暖治愈的水彩线条，梦幻柔和的动漫光影，明亮清新的色彩，高清原画品质';
      if (style === 'clay') {
        prompt = '将参考图中的人物和场景重新渲染成精美的3D泥塑黏土风格，保留参考图中的人物主体和构图布局，黏土橡皮泥材质，温润反光表面，明亮温暖的色彩，3d clay illustration';
      } else if (style === 'japanese-film') {
        prompt = '将参考图重新渲染成经典的日式复古胶片风，柔和自然的色调，清冷干净的画面，微弱的胶片颗粒感，色彩饱和度适中，温暖怀旧，富士胶片质感，高清原画品质，Japanese retro film style, soft and warm vintage colors, natural lighting, analog film grain, high quality';
      } else if (style === 'polaroid') {
        prompt = '将参考图重新渲染成经典的宝利来拍立得相机照片风格，1:1正方形构图，复古怀旧色调，画面四周带有拍立得经典的标志性宽大白色实体卡纸相框边框（底部相框较宽），富士胶片质感，温暖复古，Classic Polaroid photo with a signature white border frame, 1:1 square crop, vintage analog film look';
        size = '2048x2048';
      }

      const volcPayload = {
        model: 'doubao-seedream-5-0-260128',
        prompt: prompt,
        image: [imageDataUri],
        size: size,
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
          const finalBase64 = copyAndModifyExif(image, resultBase64, style, 'doubao-seedream-5-0');
          return res.json({ image: finalBase64, model: 'doubao-seedream-5-0', exif: exifData });
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
      dashscopePrompt = '重新渲染成经典的日式复古胶片风，柔和自然的色调，清冷干净的画面，微弱的胶片颗粒感，色彩饱和度适中，温暖怀旧，富士胶片质感，高清原画品质，Japanese retro film style, soft and warm vintage colors, natural lighting, analog film grain, high quality';
    } else if (style === 'polaroid') {
      dashscopePrompt = '重新渲染成经典的宝利来拍立得相机照片风格，1:1正方形构图，复古怀旧色调，画面四周带有拍立得经典的标志性宽大白色实体卡纸相框边框（底部相框较宽），富士胶片质感，温暖复古，Classic Polaroid photo with a signature white border frame, 1:1 square crop, vintage analog film look';
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
    const finalBase64 = copyAndModifyExif(image, resultBase64, style, 'dashscope-wanx');

    res.json({ image: finalBase64, model: 'dashscope-wanx', exif: exifData });
  } catch (error) {
    console.error('[StyleTransfer] ❌ Error:', error);
    res.status(500).json({ error: `风格化失败: ${error.message}` });
  }
});

// AI Copywriting Generator
app.post('/api/ai/generate-copy', async (req, res) => {
  try {
    const { style = '探店', keywords = '', images = [], originalImages = [] } = req.body;

    const volcKey = process.env.VOLC_API_KEY;
    const dashscopeApiKey = process.env.DASHSCOPE_API_KEY;
    if (!volcKey) {
      return res.status(500).json({ error: 'Volcano Ark Key is not configured on the server.' });
    }

    let promptStyleGuidance = '';
    if (style === '探店') {
      promptStyleGuidance = `这三款文案均应围绕【探店】风格进行创作，但侧重点不同：
- 选项一的 styleName 为 “强力种草”：语气兴奋、极具煽动性，突出探店的特色亮点、招牌特色及消费体验。
- 选项二的 styleName 为 “真实体验”：客观细致，从消费者的第一视角，介绍店内的环境、氛围、服务品质和性价比。
- 选项三的 styleName 为 “避坑与打卡”：精简吸睛，告诉读者哪里拍照最出片，有哪些拍照姿势和探店避坑小建议。

特别要求：为了规范探店格式，每一款文案的【笔记正文】（body 字段）最开头，必须强制加入以下规范的结构化店铺基本信息占位排版（空一行后再接后续详细推荐）：
📍 店名：[在此输入店名]
📍 地址：[在此输入地址]
💰 人均：[在此输入人均消费]
`;
    } else if (style === '旅行心情') {
      promptStyleGuidance = `这三款文案均应围绕【旅行心情】风格进行创作，但侧重点不同：
- 选项一的 styleName 为 “文艺治愈”：慢节奏、有故事感和温馨气息，探讨旅行中的偶遇、风景与内心的平静。
- 选项二的 styleName 为 “碎碎念记录”：活泼轻快，记录旅途中的趣味瞬间、突发小状况或真实的旅行状态。
- 选项三的 styleName 为 “金句共鸣”：文笔简练高级，探讨旅行的意义，产出容易引起小红书读者互动和收藏的金句。

特别要求：为了规范【旅行心情】格式，文案正文中绝对不允许出现任何类似于“📍 店名”、“📍 地址”、“💰 人均”等探店类的商户占位排版！取而代之，请在每一款文案的【笔记正文】（body 字段）最开头，加入以下符合旅行心情的干净目的地与时间基本信息（空一行后再接后续游记正文）：
📍 旅行目的地：[在此输入旅行地点/城市]
📅 出行时间：[在此输入出行时间/季节]
📷 记录设备：[在此输入拍摄相机/手机]
`;
    } else if (style === '运动') {
      promptStyleGuidance = `这三款文案均应围绕【运动】风格（如健身、户外、跑步、球类运动等）进行创作，但侧重点不同：
- 选项一的 styleName 为 “热血打卡”：语气高昂兴奋，极具感染力，突出运动带来的多巴胺快乐、突破自我的痛快体验。
- 选项二的 styleName 为 “经验技巧”：客观专业，介绍运动穿搭、动作要领、装备推荐、拉伸建议等实用干货。
- 选项三的 styleName 为 “运动记录”：真实接地气，记录日常运动的心路历程、碎碎念、挥洒汗水的瞬间，突出坚持的意义。`;
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

    // Extract EXIF from ORIGINAL un-compressed images (canvas-compressed ones have no EXIF)
    let exifGuidance = '';
    const exifSource = originalImages.length > 0 ? originalImages : images;
    if (exifSource && exifSource.length > 0) {
      let exifInfos = [];
      for (let i = 0; i < exifSource.length; i++) {
        const img = exifSource[i];
        const info = extractExif(img);
        if (info && (info.dateTime || info.gps || info.device)) {
          exifInfos.push(`图片 ${i + 1} EXIF 元数据：
  - 拍摄日期时间: ${info.dateTime || '未知'}
  - 拍摄位置(GPS坐标): ${info.gps ? `纬度 ${info.gps.lat} (${info.gps.latRef}), 经度 ${info.gps.lon} (${info.gps.lonRef})` : '未知'}
  - 拍摄设备: ${info.device || '未知'}`);
        }
      }
      if (exifInfos.length > 0) {
        exifGuidance = `
⚠️ 极其重要（结合真实图片EXIF拍摄信息进行创作）：
检测到这组照片中包含以下真实的 EXIF 拍摄元数据。请利用你的知识合理地将拍摄时间、日期、以及拍摄地点（如果有GPS坐标，请利用你的地理知识推算出它对应哪个真实的城市、商业区、街道或附近的地标，例如：纬度 31.218 经度 121.488 对应的是上海徐汇区/衡山路附近）自然地融入文案中。
不要机械呆板地罗列参数，而是把它们写进故事里或作为场景背景铺垫（例如：“在这个惬意的周末午后”、“在上海衡山路街头”、“拿起我的XX手机随手一拍”等），使文案显得更具现场感、真实可信和日常化。

以下是提取出的 EXIF 元数据信息：
${exifInfos.join('\n')}
`;
      }
    }

    // Analyze image content using Qwen-VL-Plus (multimodal analysis for atmosphere, people, text, objects)
    let visualGuidance = '';
    let combinedDescriptions = req.body.visualDescriptions || '';

    if (!combinedDescriptions && images && images.length > 0 && dashscopeApiKey) {
      const imagesToAnalyze = images.slice(0, 2);
      console.log(`[Copywriter] Analyzing ${imagesToAnalyze.length} (capped at 2) images using Qwen-VL in parallel...`);
      try {
        const descriptions = await Promise.all(
          imagesToAnalyze.map((img, index) => 
            analyzeImageMultimodal(img, dashscopeApiKey)
              .then(desc => desc ? `照片 ${index + 1} 画面细节描述：${desc}` : null)
          )
        );
        
        combinedDescriptions = descriptions.filter(desc => desc !== null).join('\n');
      } catch (err) {
        console.warn('[Copywriter] Multi-image analysis error:', err.message);
      }
    }

    if (combinedDescriptions) {
      visualGuidance = `
重要提示（结合这组照片的整体视觉细节与氛围进行创作）：
我们对您上传的这组照片分别进行了多模态视觉分析，各张照片的细节描述如下：
${combinedDescriptions}

请务必将这几张照片所描绘的画面内容（如具体餐食、商品、运动场景、背景物件等）、画面中的文字招牌/路牌、画面中的人物状态与神态，整合成一个连贯、真实的故事或分享内容。不要只描述其中一张，要巧妙融入所有照片反映的完整场景与体验细节，使图文高度契合、极具种草感染力。
`;
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

⚠️ 极其重要约束：除【探店】风格外，其他任何风格（如【旅行心情】、【运动】及自定义风格）的文案正文中，绝对不要出现任何类似于“📍 店名”、“📍 地址”、“💰 人均”等店铺类占位信息或相关的前缀，请直接开始自然的情感/故事正文描写。

${keywordsPrompt}
${exifGuidance}
${visualGuidance}

⚠️ 极其重要格式规范：请直接输出规范的 JSON 格式数据，以便系统直接解析，结构如下：
{
  "options": [
    {
      "styleName": "选项一的 styleName，如：强力种草",
      "title": "直接输出标题，绝对不要包含 '【爆款标题】' 标签前缀",
      "body": "直接输出正文内容，绝对不要包含 '【笔记正文】' 标签前缀",
      "tags": "直接输出话题标签（如 #探店 #美食），绝对不要包含 '【推荐话题标签】' 标签前缀"
    }
  ]
}
注意：JSON 中的字段值应当是完全纯净的文案本身，千万不要在其内容中夹杂 '【爆款标题】'、'【笔记正文】' 或 '【推荐话题标签】' 这些起提示作用的汉字字符标签！不要输出任何 Markdown 格式包裹（如 \`\`\`json 标记），不要输出任何解释性话语，直接返回纯 JSON 对象。`
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
      res.json({
        options: parsed.options || [],
        visualDescriptions: combinedDescriptions
      });
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
        ],
        visualDescriptions: combinedDescriptions
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
