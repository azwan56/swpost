import express from 'express';
import cors from 'cors';
import multer from 'multer';
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

// Multer configuration for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper: Call DashScope (OpenAI-compatible) API for multiple images
async function callDashScope(base64Images, metadata) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is not configured on the server.');
  }

  // DashScope OpenAI-compatible endpoint
  const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

  // Construct context from metadata
  let contextInfo = '';
  if (metadata) {
    if (metadata.location) contextInfo += `地点: ${metadata.location}。`;
    if (metadata.time) contextInfo += `时间: ${metadata.time}。`;
  }

  const prompt = `你是一个资深的小红书创作者和视觉设计师。请分析我上传的这组图片（共 ${base64Images.length} 张），结合拍摄地点（${metadata.location || '未知'}）和时间（${metadata.time || '未知'}），创作一篇极具吸引力的小红书风格日记，并为每一张图片推荐智能裁剪框、趣味手绘贴纸位置和手写字体文案位置。

请严格以以下 JSON 格式返回，并且返回的内容必须是合法的 JSON 格式，不能包含任何 markdown 语法或解释性前言/后记：
{
  "title": "小红书文章标题",
  "body": "文章正文内容。语言风格活泼有感染力，多用 emoji 分段排版，包含相关热门话题标签",
  "images_config": [
    {
      "index": 0,
      "crop_box": {
        "ymin": 10,
        "xmin": 15,
        "ymax": 90,
        "xmax": 75
      },
      "stickers": [
        {
          "type": "heart",
          "x": 45,
          "y": 30,
          "scale": 0.8,
          "rotation": -15
        }
      ],
      "texts": [
        {
          "content": "元气晨跑",
          "x": 20,
          "y": 80,
          "scale": 1.2,
          "rotation": -5,
          "color": "#ffffff"
        }
      ]
    }
  ]
}

关于贴纸和文字的摆放位置约束（极其重要！）：
1. 绝对不要把贴纸（如 heart, star）或手写文字直接重叠在人脸、人身躯干或主要画面焦点主体（如人、路人、雕塑、主要商品）上面，这会遮挡画面核心！
2. 贴纸和手写文字必须摆放在画面的空白边缘处（如天空、草地、跑道空地、背景树影等没有主体的区域），起到点缀画面的作用。
3. 如果使用 arrow (指向性箭头) 贴纸，其中心点 x, y 应摆放在空白处，并旋转指向主体，不要压在主体上方。
4. 贴纸的默认尺寸 scale 推荐在 0.6 到 1.0 之间即可，不宜过大，以免破坏画面平衡。

关于字段的详细说明：
1. crop_box（智能裁切框，用于把照片裁切成 3:4 比例的最佳视觉焦点区域）：
   - 请识别每张图片中的主视觉焦点（人脸、食物、核心景物）。
   - ymin, xmin, ymax, xmax 分别是裁剪矩形框在原始图片上的归一化百分比，范围在 0 到 100 之间。
2. stickers（贴纸）：
   - 从 [heart (爱心), arrow (指向性箭头), sparkle (高光星星), speech (带文字的对话框), highlight (圈圈)] 中选择 1-2 个贴纸叠加到对应图片上。
   - x, y 是贴纸中心点在已裁剪后图片上的百分比坐标（0 到 100 之间），例如 x: 80, y: 20 表示右上角。
   - scale 是缩放，推荐 0.6 到 1.0。
   - rotation 是旋转角度，推荐 -45 到 45 之间。
   - text：如果是 speech (对话框) 贴纸，请写一句 2-4 字的趣味口语化文案（例如："好美", "OMG!", "冲啊"），非 speech 贴纸此字段不要提供。
3. texts（手写字体文字）：
   - 根据照片的画面气氛（如跑步的元气活力、治愈系的自然风光等），为每张图推荐 1 个 2-4 字的手写体感叹词或短语（如"元气满满", "好治愈", "运动日常", "夏日清晨", "打卡"）。
   - x, y 是文字中心点在已裁剪后图片上的百分比坐标（0 到 100 之间）。同样要放在没有遮挡主体的空白位置。
   - scale 是字体大小缩放比例，推荐在 1.0 到 1.4 之间。
   - rotation 是旋转角度，推荐 -10 到 10 之间。
   - color 是文字颜色，推荐使用 '#ffffff' (纯白) 或 '#ffeb3b' (明黄)。`;

  // Dynamically build content list for multi-image support
  const content = [];
  base64Images.forEach((img, idx) => {
    content.push({ type: 'text', text: `图片 ${idx + 1}:` });
    content.push({ type: 'image_url', image_url: { url: img } });
  });
  content.push({ type: 'text', text: prompt });

  const payload = {
    model: 'qwen-vl-max',
    messages: [
      {
        role: 'user',
        content: content
      }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_tokens: 2000
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DashScope API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  const rawContent = result.choices?.[0]?.message?.content || '';

  // Parse and validate the response
  try {
    return JSON.parse(rawContent);
  } catch (err) {
    console.error('Failed to parse model output as JSON, attempting regex cleanup:', rawContent);
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.error('Regex JSON extract parse failed too:', e);
      }
    }
    
    // Ultimate fallback if parsing fails completely
    return {
      title: '日常碎碎念 ✨',
      body: rawContent,
      images_config: base64Images.map((_, idx) => ({
        index: idx,
        crop_box: { ymin: 0, xmin: 0, ymax: 100, xmax: 100 },
        stickers: [],
        texts: []
      }))
    };
  }
}

// 1. Reverse Geocoding Proxy (OpenStreetMap Nominatim)
app.get('/api/geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: 'lat and lon are required parameters.' });
  }

  try {
    // Nominatim reverse geocoding API
    const osmUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    
    const response = await fetch(osmUrl, {
      headers: {
        'User-Agent': 'XiaohongshuGenerator/1.0 (local development; contact: azwan)'
      }
    });

    if (!response.ok) {
      throw new Error(`OSM API responded with status ${response.status}`);
    }

    const data = await response.json();
    
    // Process and simplify the address
    const address = data.address || {};
    const city = address.city || address.town || address.village || address.municipality || '';
    const suburb = address.suburb || address.neighbourhood || '';
    const road = address.road || '';
    const amenity = address.amenity || address.shop || address.tourism || address.historic || '';
    
    let displayName = amenity 
      ? `${amenity} (${road || suburb})`
      : `${city}·${suburb || road}`.replace(/^·|·$/, '');

    if (!displayName || displayName === '·') {
      displayName = data.display_name.split(',').slice(0, 3).join(',').trim();
    }

    res.json({
      address: displayName,
      raw: data
    });
  } catch (error) {
    console.error('Geocoding error:', error);
    res.status(500).json({ error: 'Failed to reverse geocode coordinates.' });
  }
});

// 2. Generate Post Endpoint (supports multi-image upload up to 4 images)
app.post('/api/generate', upload.array('images', 4), async (req, res) => {
  try {
    let base64Images = [];
    let metadata = {};

    // Get metadata from body
    if (req.body.metadata) {
      metadata = JSON.parse(req.body.metadata);
    }

    // Check if images uploaded via files or base64 strings
    if (req.files && req.files.length > 0) {
      base64Images = req.files.map(file => {
        const mimeType = file.mimetype;
        const base64Data = file.buffer.toString('base64');
        return `data:${mimeType};base64,${base64Data}`;
      });
    } else if (req.body.images && Array.isArray(req.body.images)) {
      base64Images = req.body.images;
    } else if (req.body.image) {
      // Support single image fallback in body
      base64Images = [req.body.image];
    } else {
      return res.status(400).json({ error: 'Please upload at least one image.' });
    }

    if (base64Images.length === 0) {
      return res.status(400).json({ error: 'Please upload at least one image.' });
    }

    const aiResult = await callDashScope(base64Images, metadata);
    res.json(aiResult);
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate Xiaohongshu content.' });
  }
});

// Helper: Upload Base64 image to DashScope temporary storage
// Helper: Upload Base64 image to DashScope temporary storage
async function uploadBase64ToDashScope(base64Image) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');

  // Parse base64
  const matches = base64Image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches) {
    throw new Error('Invalid base64 image format.');
  }
  const mimeType = matches[1];
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, 'base64');

  // Convert buffer to Blob for standard Form Data upload in Node.js
  const blob = new Blob([buffer], { type: mimeType });
  const fileName = `upload-${Date.now()}.${mimeType.split('/')[1] || 'jpg'}`;

  // Method 1: Try standard Model Studio files endpoint with 'files' (plural) and 'purpose'
  const formDataStandard = new FormData();
  formDataStandard.append('files', blob, fileName);
  formDataStandard.append('purpose', 'file-extract');

  console.log('Trying standard DashScope files upload endpoint...');
  let response = await fetch('https://dashscope.aliyuncs.com/api/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formDataStandard
  });

  // Method 2: If standard fails, try compatible-mode endpoint with 'file' (singular) and 'purpose'
  if (!response.ok) {
    console.warn(`Standard files endpoint failed (status ${response.status}). Retrying with compatible endpoint...`);
    const formDataCompatible = new FormData();
    formDataCompatible.append('file', blob, fileName);
    formDataCompatible.append('purpose', 'file-extract');

    response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/files', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formDataCompatible
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DashScope upload failed: ${response.status} - ${errText}`);
  }

  const resData = await response.json();
  console.log('DashScope upload raw response:', JSON.stringify(resData));

  // Extract file ID or file URL
  const fileId = resData.id || resData.file?.id || resData.data?.uploaded_files?.[0]?.file_id || resData.file_id;
  if (fileId) {
    return `file://${fileId}`;
  }

  const fileUrl = resData.url || resData.file?.url || resData.data?.uploaded_files?.[0]?.url;
  if (fileUrl) {
    return fileUrl;
  }

  throw new Error('Failed to parse file_id or url from DashScope upload response.');
}

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
  // Assume JPEG if no prefix
  return `data:image/jpeg;base64,${base64Image}`;
}

// AI 3. Style Transfer (Ghibli, Claymation, Sketch)
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

    // ===== Primary: Volcano Ark Doubao-Seedream (highest quality) =====
    if (volcApiKey) {
      console.log(`[StyleTransfer] 使用 Volcano Ark (Doubao Seedream 5.0), style=${style}`);
      
      let prompt = '将参考图转换成极其精美的吉卜力动画风格，宫崎骏工作室手绘画风，温暖治愈的水彩线条，梦幻柔和的动漫光影，明亮清新的色彩，高清原画品质';
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

      console.log(`[StyleTransfer] Sending to Seedream: model=${volcPayload.model}, size=${volcPayload.size}, prompt length=${prompt.length}`);

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
        console.log('[StyleTransfer] Seedream response received:', JSON.stringify(volcData).substring(0, 500));
        const resultUrl = volcData.data?.[0]?.url;
        if (resultUrl) {
          console.log('[StyleTransfer] ✅ Seedream 生成成功，正在转换为 base64...');
          const resultBase64 = await convertUrlToBase64(resultUrl);
          return res.json({ image: resultBase64, model: 'doubao-seedream-5-0' });
        } else {
          // Seedream returned 200 but no image URL — unusual
          console.error('[StyleTransfer] ⚠️ Seedream returned OK but no image URL:', JSON.stringify(volcData));
          throw new Error('Seedream 返回成功但未包含图片，请重试。');
        }
      } else {
        // Seedream failed — DO NOT silently fallback, report the error clearly
        const errText = await volcResponse.text();
        console.error(`[StyleTransfer] ❌ Seedream API 调用失败 (HTTP ${volcResponse.status}): ${errText}`);
        
        // If DashScope is also not configured, throw immediately
        if (!dashscopeApiKey) {
          throw new Error(`Seedream 风格化失败 (HTTP ${volcResponse.status})，请检查火山引擎账户余额或 API Key 是否有效。`);
        }
        
        // DashScope is available as backup — log clearly and continue
        console.warn('[StyleTransfer] ⚠️ Seedream 失败，降级使用 DashScope 万相模型（画质可能降低）');
      }
    }

    // ===== Fallback: DashScope (Wanx) — only if Volcano is not configured or explicitly failed =====
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

    // ===== Attempt 1: wanx2.1-imageedit with stylization_all (highest quality style transfer) =====
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

    // ===== Fallback 1: wanx-style-repaint-v1 with style_index 1 (3D童话, closest to Ghibli) =====
    if (!taskResponse.ok) {
      const errText = await taskResponse.text();
      console.warn(`[StyleTransfer] wanx2.1-imageedit failed: ${errText}. Trying wanx-style-repaint-v1 (3D童话)...`);
      
      payload = {
        model: 'wanx-style-repaint-v1',
        input: {
          image_url: imageDataUri,
          style_index: 1 // 1: 3D童话 — warm, animated fairy-tale look
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

    // ===== Fallback 2: wanx-style-repaint-v1 with style_index 7 (炫彩卡通) =====
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
    console.log('[StyleTransfer] DashScope task response:', JSON.stringify(taskData));
    const taskId = taskData.output?.task_id || taskData.task_id || taskData.id;
    if (!taskId) throw new Error(`No task ID returned. Response: ${JSON.stringify(taskData)}`);

    // 3. Poll for result
    const resultUrl = await pollDashScopeTask(taskId);

    // 4. Convert output image back to base64
    const resultBase64 = await convertUrlToBase64(resultUrl);

    res.json({ image: resultBase64, model: 'dashscope-wanx' });
  } catch (error) {
    console.error('[StyleTransfer] ❌ Error:', error);
    res.status(500).json({ 
      error: `风格化失败: ${error.message}` 
    });
  }
});

// AI 4. Object Removal (Inpainting)
app.post('/api/ai/remove-objects', async (req, res) => {
  try {
    const { image, mask } = req.body;
    if (!image || !mask) {
      return res.status(400).json({ error: 'Both image and mask base64 data are required.' });
    }

    const imageDataUri = ensureDataUri(image);
    const maskDataUri = ensureDataUri(mask);

    // ==========================================================
    // Primary: Volcano Ark (Doubao Seedream 5.0 Inpainting)
    // ==========================================================
    const volcKey = process.env.VOLC_API_KEY;
    if (volcKey) {
      console.log('Submitting Inpainting task to Volcano Ark (doubao-seedream-5-0)...');
      try {
        const volcPayload = {
          model: 'doubao-seedream-5-0-260128',
          prompt: 'remove the marked area, clean background, restore background matching the texture and lighting, photorealistic, high quality',
          image: [imageDataUri],
          mask: [maskDataUri]
        };

        const volcResponse = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${volcKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(volcPayload)
        });

        if (volcResponse.ok) {
          const volcResult = await volcResponse.json();
          const resultUrl = volcResult.data?.[0]?.url;
          if (resultUrl) {
            console.log('Volcano Ark Inpainting succeeded synchronously.');
            const resultBase64 = await convertUrlToBase64(resultUrl);
            return res.json({ image: resultBase64 });
          }
        }
        
        const errText = await volcResponse.text();
        console.warn(`Volcano Ark Inpainting failed. Status: ${volcResponse.status} - ${errText}. Falling back to DashScope...`);
      } catch (volcErr) {
        console.error('Error during Volcano Ark inpainting, falling back to DashScope:', volcErr);
      }
    }

    // ==========================================================
    // Fallback: DashScope (Wanx image edit chain)
    // ==========================================================
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Neither Volcano Ark Key nor DashScope Key is configured.' });
    }

    // 2. Submit Inpainting task
    const taskUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis';
    
    // Attempt 1: Universal editing model (wanx2.1-imageedit) with description edit mask
    let payload = {
      model: 'wanx2.1-imageedit',
      input: {
        base_image_url: imageDataUri,
        mask_image_url: maskDataUri,
        function: 'description_edit_with_mask',
        prompt: '消除被涂抹区域，将其与周围背景平滑缝合，移除杂物'
      }
    };

    console.log('Submitting task to wanx2.1-imageedit...');
    let taskResponse = await fetch(taskUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      },
      body: JSON.stringify(payload)
    });

    // Fallback 1: Try legacy wanx-x-painting model
    if (!taskResponse.ok) {
      console.warn(`wanx2.1-imageedit task submission failed. Retrying with active model wanx-x-painting...`);
      payload = {
        model: 'wanx-x-painting',
        input: {
          base_image_url: imageDataUri,
          mask_image_url: maskDataUri,
          prompt: '背景, 移除杂物, 消除杂物 and 行人'
        }
      };

      taskResponse = await fetch(taskUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        body: JSON.stringify(payload)
      });
    }

    // Fallback 2: Try older wanx-inpainting-v1
    if (!taskResponse.ok) {
      console.warn(`wanx-x-painting failed. Retrying with legacy wanx-inpainting-v1...`);
      payload = {
        model: 'wanx-inpainting-v1',
        input: {
          image_url: imageDataUri,
          mask_url: maskDataUri,
          prompt: '背景, 移除杂物, 消除杂物 and 行人'
        }
      };

      taskResponse = await fetch(taskUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        body: JSON.stringify(payload)
      });
    }

    if (!taskResponse.ok) {
      const errText = await taskResponse.text();
      throw new Error(`Failed to submit inpainting in fallback chain: ${taskResponse.status} - ${errText}`);
    }

    const taskData = await taskResponse.json();
    console.log('Inpainting task response:', JSON.stringify(taskData));
    const taskId = taskData.output?.task_id || taskData.task_id || taskData.id;
    if (!taskId) throw new Error(`No task ID returned. Response: ${JSON.stringify(taskData)}`);

    // 3. Poll for result
    const resultUrl = await pollDashScopeTask(taskId);

    // 4. Convert output image back to base64
    const resultBase64 = await convertUrlToBase64(resultUrl);

    res.json({ image: resultBase64 });
  } catch (error) {
    console.error('Inpainting error:', error);
    res.status(500).json({ 
      error: `AI 消除失败: ${error.message}。若遇到权限或余额问题，请在阿里云百炼控制台确认图像重绘服务状态。` 
    });
  }
});

// AI 5. Generate Xiaohongshu Copywriting (Multi-modal)
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
      // Custom style defined by user
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

    // Clean Markdown code block wrapper if present
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '').trim();
    }

    try {
      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch (parseErr) {
      console.warn('JSON parsing failed, returning raw text. Text was:', text);
      // Create a fallback option if JSON parsing fails
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

// AI 6. Generate Movie Subtitles (Text-based)
app.post('/api/ai/generate-subtitles', async (req, res) => {
  try {
    const { theme = '生活' } = req.body;
    const volcKey = process.env.VOLC_API_KEY;
    if (!volcKey) {
      return res.status(500).json({ error: 'Volcano Ark Key is not configured on the server.' });
    }

    console.log(`Generating cinematic subtitles for theme: ${theme}...`);
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
            content: `你是一个金牌电影编剧。请根据主题“${theme}”，创作一句非常有电影画面感、故事感、哲理的经典电影台词。
必须输出双语格式：
1. 中文台词（20字以内）
2. 英文台词

请直接输出规范的 JSON 格式数据，以便系统直接解析，结构如下：
{
  "cn": "台词内容...",
  "en": "Subtitle translation..."
}
不要输出任何 Markdown 格式包裹（如 \`\`\`json 标记），不要输出任何解释性话语，直接返回纯 JSON 对象。`
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Volcano Subtitles API failed: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('Empty response from Volcano Subtitles model.');
    }

    // Clean Markdown code block wrapper if present
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '').trim();
    }

    try {
      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch (parseErr) {
      console.warn('JSON parsing failed for subtitles, returning fallback.');
      res.json({
        cn: '“生活没有标准答案，每个人都在走自己的路。”',
        en: 'There are no standard answers in life, everyone is on their own way.'
      });
    }
  } catch (error) {
    console.error('Subtitle generation error:', error);
    res.status(500).json({ error: `台词生成失败: ${error.message}` });
  }
});

// AI 7. Recommend Dot Tags (Multi-modal)
app.post('/api/ai/recommend-tags', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image base64 data is required.' });
    }

    const volcKey = process.env.VOLC_API_KEY;
    if (!volcKey) {
      return res.status(500).json({ error: 'Volcano Ark Key is not configured on the server.' });
    }

    const imageDataUri = ensureDataUri(image);

    console.log('Recommending Xiaohongshu dot tags using Volcano Vision model...');
    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${volcKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'doubao-seed-1-6-vision-250815',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `分析这张图片，识别出画面里的3个最核心的主体（如人物穿戴的衣服、背景中的地标、美味的食物、当时的心情），为每个主体推荐一个适合放在图片上的小红书标签，并给出推荐的相对坐标(x, y)，坐标范围为 0-100（例如 50, 50 表示正中心）。

请直接输出规范的 JSON 格式数据，以便系统直接解析，结构如下：
{
  "tags": [
    {
      "text": "标签文字...",
      "x": 45,
      "y": 60,
      "direction": "right"
    },
    ...
  ]
}
不要输出任何 Markdown 格式包裹（如 \`\`\`json 标记），不要输出任何解释性话语，直接返回纯 JSON 对象。`
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageDataUri
                }
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Volcano Vision Tags API failed: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('Empty response from Volcano Vision Tags model.');
    }

    // Clean Markdown code block wrapper if present
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '').trim();
    }

    try {
      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch (parseErr) {
      console.warn('JSON parsing failed for tags, returning fallback.');
      res.json({
        tags: [
          { text: '夏日美好 ✨', x: 30, y: 40, direction: 'right' },
          { text: '今日碎片 📷', x: 70, y: 60, direction: 'left' }
        ]
      });
    }
  } catch (error) {
    console.error('Tag recommendation error:', error);
    res.status(500).json({ error: `标签推荐失败: ${error.message}` });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  const volcKey = process.env.VOLC_API_KEY || '';
  const dashKey = process.env.DASHSCOPE_API_KEY || '';
  res.json({ 
    status: 'ok', 
    dashscopeConfigured: !!dashKey,
    dashscopeKeyPrefix: dashKey ? dashKey.substring(0, 6) + '***' : null,
    volcConfigured: !!volcKey,
    volcKeyPrefix: volcKey ? volcKey.substring(0, 6) + '***' : null,
    primaryStyleEngine: volcKey ? 'doubao-seedream-5-0' : dashKey ? 'dashscope-wanx' : 'none'
  });
});

// Serve static files from React build folder in production
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// For all other requests, return index.html (client-side routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`API Health Check: http://localhost:${port}/api/health`);
});
