from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from rag_engine import load_qa_chain

# Init FastAPI app
app = FastAPI()

# Enable CORS for frontend dev (optional)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Replace with frontend origin in production
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load RAG chain on startup
qa_chain = load_qa_chain()

@app.post("/ask")
async def ask_question(request: Request):
    body = await request.json()
    question = body.get("question", "")
    if not question:
        return {"error": "Question is required."}

    answer = qa_chain.run(question)
    return {"answer": answer}
