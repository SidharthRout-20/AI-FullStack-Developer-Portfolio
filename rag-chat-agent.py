from langchain.document_loaders import PyPDFLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.vectorstores import Chroma
from langchain.embeddings import HuggingFaceEmbeddings
from langchain.chains import RetrievalQA
from langchain_community.llms import Ollama

# Constants
PDF_PATH = "Sidharth_Rout_Resume.pdf"
CHROMA_DB_DIR = "db"
EMBEDDING_MODEL = "all-MiniLM-L6-v2"
OLLAMA_MODEL = "llama3"  # or "mistral", "zephyr", etc.


def load_qa_chain():
    # Load and split resume PDF
    loader = PyPDFLoader(PDF_PATH)
    documents = loader.load()

    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=500, chunk_overlap=50
    )
    chunks = text_splitter.split_documents(documents)

    # Generate embeddings
    embeddings = HuggingFaceEmbeddings(model_name=EMBEDDING_MODEL)

    # Create or load Chroma vector store
    vectordb = Chroma.from_documents(
        documents=chunks,
        embedding=embeddings,
        persist_directory=CHROMA_DB_DIR,
    )
    vectordb.persist()

    # Use Ollama LLM (LangChain native integration)
    llm = Ollama(model=OLLAMA_MODEL)

    # RAG chain
    qa_chain = RetrievalQA.from_chain_type(
        llm=llm,
        retriever=vectordb.as_retriever(),
        return_source_documents=False,
    )

    return qa_chain
