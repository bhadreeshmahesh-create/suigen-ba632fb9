import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface FeatureMeta {
  value: string;
  locked: boolean;
  confidence: number;
}

type FeatureMetadata = Record<string, FeatureMeta>;

function getPrompt(features: FeatureMetadata): string {
  const f = (key: string, fallback: string) =>
    features[key]?.value && features[key].value !== "null"
      ? features[key].value
      : fallback;

  const gender = f("gender", "person");
  const age = f("age", "adult");
  const height = f("height", "average height");
  const build = f("build", "average build");
  const skinTone = f("skin_tone", "");
  const hairColor = f("hair_color", "");
  const hairStyle = f("hair_style", "");
  const facialHair = f("facial_hair", "clean-shaven");
  const eyeColor = f("eye_color", "");
  const distinguishingFeatures = f("distinguishing_features", "");
  const clothing = f("clothing", "casual clothing");

  let prompt = `Police sketch style portrait of a ${gender}, ${age}, ${height}, ${build}`;
  if (skinTone) prompt += `, ${skinTone} skin tone`;
  if (hairColor || hairStyle) prompt += `, ${hairColor} ${hairStyle}`.trim();
  if (facialHair) prompt += `, ${facialHair}`;
  if (eyeColor) prompt += `, ${eyeColor} eyes`;
  if (distinguishingFeatures) prompt += `, ${distinguishingFeatures}`;
  prompt += `. Wearing ${clothing}. Front-facing, neutral expression, detailed pencil sketch, grayscale, high contrast, plain background.`;

  return prompt;
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(supabaseUrl, supabaseKey);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { features, case_id } = await req.json();

    if (!features || typeof features !== "object") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid features" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const prompt = getPrompt(features as FeatureMetadata);

    const googleApiKey = Deno.env.get("GOOGLE_API_KEY");
    if (!googleApiKey) {
      throw new Error("GOOGLE_API_KEY is not set");
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=${googleApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"]
          }
        }),
      }
    );

    if (!geminiRes.ok) {
      const errorText = await geminiRes.text();
      throw new Error(`Gemini API error: ${geminiRes.status} ${errorText}`);
    }

    const geminiData = await geminiRes.json();

    const parts = geminiData.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p: any) => p.inlineData?.data);
    if (!imagePart) {
      throw new Error("No image returned from Gemini API");
    }

    const base64Image = imagePart.inlineData.data;
    const mimeType = imagePart.inlineData.mimeType ?? "image/png";

    const imageUrl = `data:${mimeType};base64,${base64Image}`;

    const { error: dbError } = await supabase
      .from("suspect_images")
      .insert({ case_id, image_url: imageUrl, features });

    if (dbError) {
      console.error("Supabase insert error:", dbError);
    }

    return new Response(
      JSON.stringify({ images: [imageUrl] }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in generate-suspect-image:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error occurred",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
