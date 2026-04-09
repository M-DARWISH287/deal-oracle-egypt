const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { query } = await req.json()
    if (!query || typeof query !== 'string') {
      return new Response(
        JSON.stringify({ normalized: query || '', raw: query || '' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const apiKey = Deno.env.get('LOVABLE_API_KEY')
    if (!apiKey) {
      console.error('LOVABLE_API_KEY not configured, returning raw query')
      return new Response(
        JSON.stringify({ normalized: query.trim(), raw: query.trim() }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [
          {
            role: 'system',
            content: `You are an e-commerce search term optimizer. Translate the user's raw query (often Arabic, with typos, or informal like 'ايفون 15') into a clean, standard English brand and model name. Output ONLY the optimized term, nothing else. Examples:
- "ايفون 15" -> "Apple iPhone 15"
- "سامسونج اس 24" -> "Samsung Galaxy S24"
- "ماك بوك برو" -> "MacBook Pro"
- "بلايستيشن 5" -> "PlayStation 5"
- "airpods pro 2" -> "Apple AirPods Pro 2"
- "لابتوب ديل" -> "Dell Laptop"`,
          },
          { role: 'user', content: query.trim() },
        ],
      }),
    })

    if (!response.ok) {
      console.error('AI gateway error:', response.status)
      return new Response(
        JSON.stringify({ normalized: query.trim(), raw: query.trim() }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const data = await response.json()
    const normalized = data.choices?.[0]?.message?.content?.trim() || query.trim()

    console.log(`Normalized: "${query.trim()}" -> "${normalized}"`)
    return new Response(
      JSON.stringify({ normalized, raw: query.trim() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('Normalize error:', err)
    const raw = ''
    return new Response(
      JSON.stringify({ normalized: raw, raw }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
