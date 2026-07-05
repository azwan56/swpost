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

// AI 3. Style Transfer (Ghibli cartoonization)
app.post('/api/ai/style-transfer', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image base64 data is required.' });
    }

    const imageDataUri = ensureDataUri(image);
    const volcApiKey = process.env.VOLC_API_KEY;
    const dashscopeApiKey = process.env.DASHSCOPE_API_KEY;

    if (!volcApiKey && !dashscopeApiKey) {
      return res.status(500).json({ error: 'Neither VOLC_API_KEY nor DASHSCOPE_API_KEY is configured.' });
    }

    // ===== Option A: Try Volcano Ark Doubao-Seedream first if key is present =====
    if (volcApiKey) {
      try {
        console.log('Attempting Ghibli style transfer using Volcano Ark (Doubao Seedream)...');
        
        const volcResponse = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${volcApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'doubao-seedream-5-0-260128',
            prompt: '将参考图转换成极其精美的吉卜力动画风格，宫崎骏工作室手绘画风，温暖治愈的水彩线条，梦幻柔和的动漫光影，明亮清新的色彩，高清原画品质',
            image: [imageDataUri],
            size: '2048x2048',
            n: 1
          })
        });

        if (volcResponse.ok) {
          const volcData = await volcResponse.json();
          console.log('Volcano Ark response data:', JSON.stringify(volcData));
          const resultUrl = volcData.data?.[0]?.url;
          if (resultUrl) {
            console.log('Volcano Ark generation succeeded! Converting URL to base64...');
            const resultBase64 = await convertUrlToBase64(resultUrl);
            return res.json({ image: resultBase64 });
          }
        } else {
          const errText = await volcResponse.text();
          console.warn(`Volcano Ark API call failed (status ${volcResponse.status}): ${errText}`);
        }
      } catch (volcErr) {
        console.error('Error during Volcano Ark style transfer, falling back to DashScope:', volcErr);
      }
    }

    // ===== Option B: Fallback to DashScope (Wanx) Models =====
    if (!dashscopeApiKey) {
      throw new Error('Volcano Ark failed and DashScope is not configured.');
    }

    console.log('Running fallback Ghibli style transfer using Aliyun DashScope (Wanx)...');
    // Submit Style Transfer task
    const imageeditUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis';
    const reprintUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation';
    
    // ===== Attempt 1: wanx2.1-imageedit with stylization_all (highest quality Ghibli) =====
    let payload = {
      model: 'wanx2.1-imageedit',
      input: {
        base_image_url: imageDataUri,
        function: 'stylization_all',
        prompt: '转换成吉卜力动画风格，宫崎骏工作室风格，柔和水彩质感，温暖明亮的色调，细腻的手绘线条，梦幻唯美的动漫画风'
      },
      parameters: {
        n: 1
      }
    };

    console.log('Submitting task to wanx2.1-imageedit (stylization_all, Ghibli)...');
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
      console.warn(`wanx2.1-imageedit stylization_all failed: ${errText}. Trying wanx-style-repaint-v1 (3D童话)...`);
      
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
      console.warn(`wanx-style-repaint-v1 3D童话 failed: ${errText}. Trying style_index 7 (炫彩卡通)...`);
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
      throw new Error(`Failed to submit style transfer (tried repaint, imageedit, cosplay): ${taskResponse.status} - ${errText}`);
    }

    const taskData = await taskResponse.json();
    console.log('Style transfer task response:', JSON.stringify(taskData));
    const taskId = taskData.output?.task_id || taskData.task_id || taskData.id;
    if (!taskId) throw new Error(`No task ID returned. Response: ${JSON.stringify(taskData)}`);

    // 3. Poll for result
    const resultUrl = await pollDashScopeTask(taskId);

    // 4. Convert output image back to base64
    const resultBase64 = await convertUrlToBase64(resultUrl);

    res.json({ image: resultBase64 });
  } catch (error) {
    console.error('Style transfer error:', error);
    res.status(500).json({ 
      error: `动漫风格化失败: ${error.message}。若遇到模型权限或余额不足，请在阿里云百炼控制台确认万相服务状态。` 
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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`API Health Check: http://localhost:${port}/api/health`);
});
